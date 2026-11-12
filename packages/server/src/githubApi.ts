import { createSign } from "node:crypto";

import type { RepoFile } from "@halinka/protocol";
import { hashOf } from "@halinka/utils/hash";
import { maxFileMib, maxFiles, maxTotalMib, mib } from "@halinka/utils/repoFiles";
import { definitionsFolder } from "@halinka/workflow";
import { z } from "zod";

import type { InstallationValues } from "./db/repositories";
import { noGitHubAnswer, ServiceError } from "./services/serviceError";

const apiUrl = "https://api.github.com";
const timeoutMs = 10_000;
const pageSize = 100;
const blobBatch = 20;
// GitHub refuses more than 10 minutes, and a clock can be behind.
const jwtSeconds = { before: 60, after: 9 * 60 };

const convertedAppSchema = z.object({
  id: z.number(),
  slug: z.string(),
  html_url: z.string(),
  owner: z.object({ id: z.number(), login: z.string() }),
  pem: z.string(),
  webhook_secret: z.string().nullable(),
});

const installationsSchema = z.array(
  z.object({
    id: z.number(),
    account: z.object({ login: z.string() }),
    suspended_at: z.string().nullable(),
  }),
);

const installationReposSchema = z.object({
  repositories: z.array(
    z.object({ id: z.number(), name: z.string(), owner: z.object({ login: z.string() }) }),
  ),
});

const userSchema = z.object({ id: z.number(), login: z.string(), type: z.string() });

const accessTokenSchema = z.object({ token: z.string() });

const repoAccessTokenSchema = installationReposSchema.extend(accessTokenSchema.shape);

const repoInfoSchema = z.object({ default_branch: z.string() });

const branchRefSchema = z.object({ object: z.object({ sha: z.string() }) });

const treeEntrySchema = z.object({
  path: z.string(),
  mode: z.string(),
  type: z.string(),
  sha: z.string(),
  size: z.number().default(0),
});

type TreeEntry = z.infer<typeof treeEntrySchema>;

const treeSchema = z.object({ tree: z.array(treeEntrySchema), truncated: z.boolean() });

const blobSchema = z.object({ content: z.string(), encoding: z.literal("base64") });

const shaAnswerSchema = z.object({ sha: z.string() });

const commitTreeSchema = z.object({ tree: shaAnswerSchema });

const matchingRefsSchema = z.array(z.object({ ref: z.string() }));

const pullRequestSchema = z.object({ html_url: z.string() });

const pullRequestsSchema = z.array(pullRequestSchema);

const isRegularFile = ({ mode }: TreeEntry) => mode === "100644" || mode === "100755";

type Call = { token?: string; body?: object; method?: "GET" | "POST" };

type Answer = { isOk: boolean; status: number; statusText: string; value: unknown };

const send = async (path: string, { token, body, method = "GET" }: Call): Promise<Answer> => {
  const answer = await fetch(`${apiUrl}${path}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "User-Agent": "halinka",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body && { "Content-Type": "application/json" }),
    },
    ...(body && { body: JSON.stringify(body) }),
  }).catch(() => {
    throw noGitHubAnswer();
  });
  const value: unknown = await answer.json().catch(() => undefined);
  return { isOk: answer.ok, status: answer.status, statusText: answer.statusText, value };
};

const parseAnswer = <T>(path: string, answerShape: z.ZodType<T>, answer: Answer) => {
  const { isOk, status, statusText, value } = answer;
  if (!isOk) {
    const { message } = (value ?? {}) as { message?: unknown };
    const reason = typeof message === "string" ? message : statusText;
    throw new ServiceError(
      "BAD_REQUEST",
      reason ? `GitHub answered ${status}: ${reason}` : `GitHub answered ${status}`,
    );
  }
  const parsed = answerShape.safeParse(value);
  if (!parsed.success) {
    throw new ServiceError(
      "BAD_REQUEST",
      `GitHub gave an unknown answer for ${path.split("?")[0]}`,
    );
  }
  return parsed.data;
};

const request = async <T>(path: string, answerShape: z.ZodType<T>, call: Call) =>
  parseAnswer(path, answerShape, await send(path, call));

// An item that moves between two reads comes two times.
const readPages = async <T extends { id: number }>(read: (query: string) => Promise<T[]>) => {
  const items = new Map<number, T>();
  for (let page = 1; ; page++) {
    const found = await read(`?per_page=${pageSize}&page=${page}`);
    for (const item of found) items.set(item.id, item);
    if (found.length < pageSize) return [...items.values()];
  }
};

const base64Url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

const appJwt = (appId: number, privateKey: string) => {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iat: now - jwtSeconds.before, exp: now + jwtSeconds.after, iss: String(appId) };
  const body = `${base64Url({ alg: "RS256", typ: "JWT" })}.${base64Url(claims)}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(privateKey, "base64url")}`;
};

export const convertManifest = (code: string) =>
  request(`/app-manifests/${encodeURIComponent(code)}/conversions`, convertedAppSchema, {
    method: "POST",
  });

const readInstallationRepos = async (installationId: number, jwt: string) => {
  const { token } = await request(
    `/app/installations/${installationId}/access_tokens`,
    accessTokenSchema,
    { token: jwt, method: "POST", body: { permissions: { metadata: "read" } } },
  );
  const repos = await readPages(async (query) => {
    const path = `/installation/repositories${query}`;
    const { repositories } = await request(path, installationReposSchema, { token });
    return repositories;
  });
  return repos.map(({ id, name, owner }) => ({ githubId: id, owner: owner.login, name }));
};

type RepoTokenOptions = {
  appId: number;
  privateKey: string;
  installationId: number;
  repoId: number;
  permissions: Record<string, string>;
};

export const createRepoToken = async ({
  appId,
  privateKey,
  installationId,
  repoId,
  permissions,
}: RepoTokenOptions) => {
  const { token, repositories } = await request(
    `/app/installations/${installationId}/access_tokens`,
    repoAccessTokenSchema,
    {
      token: appJwt(appId, privateKey),
      method: "POST",
      body: { repository_ids: [repoId], permissions },
    },
  );
  const repo = repositories.find(({ id }) => id === repoId);
  if (!repo) throw new ServiceError("BAD_REQUEST", "GitHub gave a token for another repo");
  return { token, owner: repo.owner.login, name: repo.name };
};

export type RepoAccess = Awaited<ReturnType<typeof createRepoToken>>;

const refused = (message: string) => new ServiceError("INVALID_DEFINITIONS", message);

const repoPathOf = ({ owner, name }: RepoAccess) =>
  `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

const readTree = (access: RepoAccess, sha: string, query = "") =>
  request(`${repoPathOf(access)}/git/trees/${sha}${query}`, treeSchema, { token: access.token });

const readBlob = async (access: RepoAccess, sha: string) => {
  const path = `${repoPathOf(access)}/git/blobs/${sha}`;
  const { content } = await request(path, blobSchema, { token: access.token });
  return Buffer.from(content, "base64");
};

const findEntry = async (
  access: RepoAccess,
  treeSha: string,
  [segment, ...rest]: string[],
): Promise<TreeEntry | undefined> => {
  const { tree: entries, truncated } = await readTree(access, treeSha);
  const entry = entries.find(({ path }) => path === segment);
  if (!entry && truncated) throw refused(`A folder of ${access.name} has too many files to read`);
  if (!entry || rest.length === 0) return entry;
  return entry.type === "tree" ? findEntry(access, entry.sha, rest) : undefined;
};

const requireWithinLimits = (files: TreeEntry[]) => {
  if (files.length > maxFiles) {
    throw refused(`${definitionsFolder}/ has more than ${maxFiles} files`);
  }
  const large = files.find(({ size }) => size > maxFileMib * mib);
  if (large) throw refused(`${definitionsFolder}/${large.path} is larger than ${maxFileMib} MiB`);
  if (files.reduce((total, { size }) => total + size, 0) > maxTotalMib * mib) {
    throw refused(`${definitionsFolder}/ is larger than ${maxTotalMib} MiB`);
  }
};

export const readDefinitions = async (access: RepoAccess) => {
  const { token } = access;
  const path = repoPathOf(access);
  const { default_branch: defaultBranch } = await request(path, repoInfoSchema, { token });
  const refPath = defaultBranch.split("/").map(encodeURIComponent).join("/");
  const { object } = await request(`${path}/git/ref/heads/${refPath}`, branchRefSchema, { token });
  const head = object.sha;
  const files: Record<string, RepoFile> = {};
  const folder = await findEntry(access, head, [definitionsFolder]);
  if (!folder) return { head, defaultBranch, files };
  if (folder.type !== "tree")
    throw refused(`${definitionsFolder} in ${access.name} is not a folder`);
  const { tree: entries, truncated } = await readTree(access, folder.sha, "?recursive=1");
  if (truncated) throw refused(`${definitionsFolder}/ has more than ${maxFiles} files`);
  const found = entries.filter(isRegularFile);
  requireWithinLimits(found);
  for (let start = 0; start < found.length; start += blobBatch) {
    await Promise.all(
      found.slice(start, start + blobBatch).map(async ({ path: filePath, sha }) => {
        const bytes = await readBlob(access, sha);
        files[`${definitionsFolder}/${filePath}`] = {
          source: bytes.toString("utf8"),
          hash: hashOf(bytes),
        };
      }),
    );
  }
  return { head, defaultBranch, files };
};

export const readCommitFile = async (access: RepoAccess, commit: string, path: string) => {
  const entry = await findEntry(access, commit, path.split("/"));
  if (!entry || !isRegularFile(entry)) return undefined;
  if (entry.size > maxFileMib * mib) throw refused(`${path} is larger than ${maxFileMib} MiB`);
  return { source: (await readBlob(access, entry.sha)).toString("utf8") };
};

type DraftCommit = { head: string; path: string; source: string; branch: string };

// The branch comes last: a failure before it leaves nothing that a retry can take for the draft.
const createDraftBranch = async (
  access: RepoAccess,
  { head, path, source, branch }: DraftCommit,
) => {
  const { token } = access;
  const gitPath = `${repoPathOf(access)}/git`;
  const { tree: baseTree } = await request(`${gitPath}/commits/${head}`, commitTreeSchema, {
    token,
  });
  const tree = await request(`${gitPath}/trees`, shaAnswerSchema, {
    token,
    method: "POST",
    body: {
      base_tree: baseTree.sha,
      tree: [{ path, mode: "100644", type: "blob", content: source }],
    },
  });
  const commit = await request(`${gitPath}/commits`, shaAnswerSchema, {
    token,
    method: "POST",
    body: { message: "Publish a workflow draft", tree: tree.sha, parents: [head] },
  });
  await request(`${gitPath}/refs`, branchRefSchema, {
    token,
    method: "POST",
    body: { ref: `refs/heads/${branch}`, sha: commit.sha },
  });
};

// The name of the branch holds the hash of the draft, so an existing branch has this draft.
export const publishDraft = async (
  access: RepoAccess,
  draft: DraftCommit,
  text: { title: string; body: string },
) => {
  const { token, owner } = access;
  const repoPath = repoPathOf(access);
  const { branch } = draft;
  const hasBranch = async () => {
    const refs = await request(
      `${repoPath}/git/matching-refs/heads/${branch}`,
      matchingRefsSchema,
      {
        token,
      },
    );
    return refs.some(({ ref }) => ref === `refs/heads/${branch}`);
  };
  const head = encodeURIComponent(`${owner}:${branch}`);
  const findOpen = async () => {
    const [open] = await request(
      `${repoPath}/pulls?state=open&per_page=1&head=${head}`,
      pullRequestsSchema,
      { token },
    );
    return open?.html_url;
  };
  // A failed write can be a second publish that came first, so each failure reads again.
  if (!(await hasBranch())) {
    await createDraftBranch(access, draft).catch(async (error: unknown) => {
      if (!(await hasBranch())) throw error;
    });
  }
  const open = await findOpen();
  if (open) return open;
  const { default_branch: base } = await request(repoPath, repoInfoSchema, { token });
  try {
    const created = await request(`${repoPath}/pulls`, pullRequestSchema, {
      token,
      method: "POST",
      body: { ...text, head: branch, base, draft: true },
    });
    return created.html_url;
  } catch (error) {
    const url = await findOpen();
    if (!url) throw error;
    return url;
  }
};

export const findUser = async (login: string) => {
  const path = `/users/${encodeURIComponent(login)}`;
  const answer = await send(path, {});
  return answer.status === 404 ? undefined : parseAnswer(path, userSchema, answer);
};

// A suspended installation gives no token.
export const readInstallations = async (
  appId: number,
  privateKey: string,
): Promise<InstallationValues[]> => {
  const token = appJwt(appId, privateKey);
  const found = await readPages((query) =>
    request(`/app/installations${query}`, installationsSchema, { token }),
  );
  return Promise.all(
    found.map(async ({ id, account, suspended_at: suspendedAt }) => ({
      githubId: id,
      accountLogin: account.login,
      isSuspended: suspendedAt !== null,
      repos: suspendedAt === null ? await readInstallationRepos(id, token) : [],
    })),
  );
};
