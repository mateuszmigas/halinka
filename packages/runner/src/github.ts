import { homedir } from "node:os";

import { conflict, type PullRequestOpen } from "@halinka/protocol";
import { HostSandbox } from "@halinka/sandbox/host";
import { errorMessage } from "@halinka/utils/errors";
import { type Git, shortSha } from "@halinka/utils/git";

import { LentValues } from "./lentValues";

export type GitHubRepo = { owner: string; name: string };

const basicHeader = (token: string) => Buffer.from(`x-access-token:${token}`).toString("base64");

export const addToken = (values: Pick<LentValues, "add">, token: string) => {
  values.add("GITHUB_TOKEN", token);
  values.add("GITHUB_TOKEN", basicHeader(token));
};

// Not in the shared record: it only grows, and this token ends with its action.
export const actionMask = (token: string | undefined) => {
  const mask = new LentValues();
  if (token) addToken(mask, token);
  return mask;
};

export const repoUrlOf = (gitHubUrl: string, { owner, name }: GitHubRepo) =>
  `${gitHubUrl}/${owner}/${name}.git`;

// A worktree agent can write the config of its repo.
export const requireNoUrlRewrite = async (git: Git, url: string, hint: string) => {
  const rewrite = (await git.listUrlRewrites()).find((prefix) => url.startsWith(prefix));
  if (rewrite) throw conflict(`The git config rewrites ${rewrite}. ${hint}`);
};

export const tokenGitConfig = (gitHubUrl: string, token: string) => ({
  // An empty helper list: git sends only the header.
  "credential.helper": "",
  [`http.${gitHubUrl}/.extraheader`]: `Authorization: Basic ${basicHeader(token)}`,
});

// A token that can push to the repo and open a pull request in it.
export type GitHubAuth = { token: (signal: AbortSignal) => Promise<string> };

const part = "([A-Za-z0-9_.-]+)";
const remotePatterns = [
  new RegExp(`^https://github\\.com/${part}/${part}/?$`),
  new RegExp(`^git@github\\.com:${part}/${part}$`),
  new RegExp(`^ssh://git@github\\.com/${part}/${part}/?$`),
];

export const parseGitHubRemote = (url: string): GitHubRepo | undefined => {
  for (const pattern of remotePatterns) {
    const [, owner, name] = pattern.exec(url) ?? [];
    if (owner && name) return { owner, name: name.replace(/\.git$/, "") };
  }
  return undefined;
};

export const ghLogin: GitHubAuth = {
  token: async (signal) => {
    const noLogin = (reason: string) =>
      conflict(
        `The runner user has no GitHub login (${reason}). Run gh auth login on the runner host, or link the repo on the GitHub page`,
      );
    const { exitCode, stdout, stderr } = await new HostSandbox(homedir())
      .exec(["gh", "auth", "token", "--hostname", "github.com"], {
        signal,
        maxOutputChars: 64 * 1024,
      })
      .catch((error: Error) => {
        if (signal.aborted) throw error;
        throw noLogin(error.message);
      });
    if (exitCode !== 0) throw noLogin(stderr.trim());
    return stdout.trim();
  },
};

export type GitHubCall = { apiUrl: string; token: string; signal: AbortSignal };

const reasonOf = (answer: unknown, statusText: string) => {
  const { message, errors } = (answer ?? {}) as { message?: unknown; errors?: unknown };
  // A 422 tells the reason in `errors`.
  const details = (Array.isArray(errors) ? errors : []).map((error: unknown) =>
    typeof error === "string" ? error : (error as { message?: unknown } | null)?.message,
  );
  const reasons = [typeof message === "string" ? message : statusText, ...details];
  return reasons.filter((reason) => typeof reason === "string").join(": ");
};

const request = async ({ apiUrl, token, signal }: GitHubCall, path: string, body?: object) => {
  const response = await fetch(`${apiUrl}${path}`, {
    method: body ? "POST" : "GET",
    // A redirect would turn the POST into a GET.
    redirect: "error",
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body && { "Content-Type": "application/json" }),
    },
    ...(body && { body: JSON.stringify(body) }),
  }).catch((error: Error) => {
    if (signal.aborted) throw error;
    throw new Error(`Halinka could not reach GitHub: ${errorMessage(error.cause ?? error)}`);
  });
  const answer: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status}: ${reasonOf(answer, response.statusText)}`);
  }
  return answer;
};

type PullRequestOf = { html_url?: unknown; base?: { ref?: unknown }; head?: { ref?: unknown } };

// Only a pull request of this repo: the URL goes to the portal unmasked.
const urlOf = ({ owner, name }: GitHubRepo, pull: PullRequestOf | undefined) => {
  const url = pull?.html_url;
  const prefix = `https://github.com/${owner}/${name}/pull/`.toLowerCase();
  const isOfRepo =
    typeof url === "string" &&
    url.toLowerCase().startsWith(prefix) &&
    /^\d+$/.test(url.slice(prefix.length));
  if (!isOfRepo) throw new Error("GitHub answered a pull request without a URL of this repo");
  return url;
};

type RequireBaseOptions = { branch: string; baseSha: string };

// A base that is not on the branch puts commits of other work into the pull request.
const requireBaseOn = async (
  call: GitHubCall,
  repoPath: string,
  { branch, baseSha }: RequireBaseOptions,
) => {
  const path = `${repoPath}/compare/${encodeURIComponent(branch)}...${baseSha}`;
  const { status } = ((await request(call, path)) ?? {}) as { status?: unknown };
  if (status !== "identical" && status !== "behind") {
    throw new Error(`The base ${shortSha(baseSha)} of the run is not on ${branch}. Push it first`);
  }
};

type PostCommentOptions = { pullRequestNumber: number; text: string };

export const postComment = async (
  call: GitHubCall,
  { owner, name }: GitHubRepo,
  { pullRequestNumber, text }: PostCommentOptions,
) => {
  const path = `/repos/${owner}/${name}/issues/${pullRequestNumber}/comments`;
  const answer = (await request(call, path, { body: text })) as { html_url?: unknown } | undefined;
  const url = answer?.html_url;
  const prefix = `https://github.com/${owner}/${name}/`.toLowerCase();
  // The URL goes to the portal with no mask.
  if (typeof url !== "string" || !url.toLowerCase().startsWith(prefix)) {
    throw new Error("GitHub answered without a comment of this repo");
  }
  return url;
};

export const openPullRequest = async (
  call: GitHubCall,
  repo: GitHubRepo,
  { branch, baseSha, title, body }: Pick<PullRequestOpen, "branch" | "baseSha" | "title" | "body">,
) => {
  const repoPath = `/repos/${repo.owner}/${repo.name}`;
  const head = encodeURIComponent(`${repo.owner}:${branch}`);
  const [open, details] = await Promise.all([
    request(call, `${repoPath}/pulls?state=open&per_page=1&head=${head}`),
    request(call, repoPath),
  ]);
  if (!Array.isArray(open))
    throw new Error("GitHub answered the open pull requests without a list");
  const existing = open[0] as PullRequestOf | undefined;
  if (existing) {
    if (existing.head?.ref !== branch) {
      throw new Error("GitHub answered a pull request of another branch");
    }
    const base = existing.base?.ref;
    if (typeof base !== "string") throw new Error("GitHub answered a pull request without a base");
    await requireBaseOn(call, repoPath, { branch: base, baseSha });
    return { url: urlOf(repo, existing), isCreated: false };
  }
  const base = (details as { default_branch?: unknown } | undefined)?.default_branch;
  if (typeof base !== "string") throw new Error("GitHub answered without a default branch");
  await requireBaseOn(call, repoPath, { branch: base, baseSha });
  const pull = { title, body, head: branch, base, draft: true };
  return {
    url: urlOf(repo, (await request(call, `${repoPath}/pulls`, pull)) as PullRequestOf),
    isCreated: true,
  };
};
