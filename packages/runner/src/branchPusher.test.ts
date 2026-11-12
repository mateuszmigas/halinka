import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import type { GitHubAccess } from "@halinka/protocol";
import { hostGit } from "@halinka/sandbox/host";
import { FileLocks } from "@halinka/utils/fileLocks";
import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it, vi } from "vitest";

import { BranchPusher } from "./branchPusher";
import type { GitHubAuth } from "./github";
import { GitHubMirrors } from "./githubMirrors";
import { LentValues } from "./lentValues";
import {
  commitAll,
  commitFile,
  createRepo,
  gitHttpServer,
  identity,
  listenForTest,
} from "./testing";
import { runFolderName } from "./workspaces";

const branch = "halinka/run-1";
const gitHubUrl = "https://github.com/acme/app.git";
const token: GitHubAuth = { token: async () => "gho-test-token-1" };

type ApiRequest = { method: string; url: string; authorization?: string; body?: unknown };
type ApiAnswer = { status: number; body: unknown; hangs?: boolean };
type ApiRoute = "pulls" | "repo" | "compare" | "create";

const json = (body: unknown, status = 200): ApiAnswer => ({ status, body });

const defaultAnswers: Record<ApiRoute, ApiAnswer> = {
  pulls: json([]),
  repo: json({ default_branch: "main" }),
  compare: json({ status: "behind" }),
  create: json({ html_url: "https://github.com/acme/app/pull/7" }, 201),
};

const routeOf = (method: string, url: string): ApiRoute | undefined => {
  if (method === "POST" && url === "/repos/acme/app/pulls") return "create";
  if (url.startsWith("/repos/acme/app/pulls?")) return "pulls";
  if (url.startsWith("/repos/acme/app/compare/")) return "compare";
  if (url === "/repos/acme/app") return "repo";
  return undefined;
};

// The repo acme/app; `answers` replaces the answer of a route. A string body is sent as text.
const fakeGitHubApi = async (answers: Partial<Record<ApiRoute, ApiAnswer>> = {}) => {
  const requests: ApiRequest[] = [];
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const { method = "", url = "" } = request;
    requests.push({
      method,
      url,
      authorization: request.headers.authorization,
      ...(text && { body: JSON.parse(text) as unknown }),
    });
    const route = routeOf(method, url);
    const { status, body, hangs } = route
      ? (answers[route] ?? defaultAnswers[route])
      : json({ message: "Not Found" }, 404);
    if (hangs) return;
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const url = await listenForTest((request, response) => void handle(request, response));
  return { url, requests };
};

// "GitHub" is a folder: the pusher pushes to `<folder>/acme/app.git`.
const setUp = async ({
  origin = gitHubUrl,
  auth = token,
  timeoutMs = 50_000,
  lockTimeoutMs = 0,
  apiUrl = "http://127.0.0.1:1",
  github = undefined as GitHubAccess | undefined,
  gitHubFolder = undefined as string | undefined,
  pushUrl = undefined as string | undefined,
} = {}) => {
  gitHubFolder ??= await tempFolder();
  const bare = join(gitHubFolder, "acme/app.git");
  await mkdir(bare, { recursive: true });
  await hostGit(bare).run("init", "--quiet", "--bare");
  const repoPath = await createRepo();
  const git = hostGit(repoPath, identity);
  await git.run("remote", "add", "origin", origin);
  const baseSha = await git.run("rev-parse", "HEAD");
  await git.run("switch", "--quiet", "-c", branch);
  const lent = new LentValues();
  const workspacesFolder = await tempFolder();
  const locks = new FileLocks(workspacesFolder, "test");
  const workspaces = { groupsFileOf: (id: number) => join(workspacesFolder, `run-${id}.groups`) };
  const gitHubFolderUrl = `file://${gitHubFolder}`;
  const mirrors = new GitHubMirrors(await tempFolder());
  const pusher = new BranchPusher({
    locks,
    workspaces,
    mirrors,
    lent,
    auth,
    gitHubUrl: pushUrl ?? gitHubFolderUrl,
    apiUrl,
    timeoutMs,
    lockTimeoutMs,
  });
  const input = (commit: string, pushedCommit?: string, pullRequestNumber?: number) => ({
    workflowRunId: 1,
    repoPath,
    branch,
    baseSha,
    commit,
    pushedCommit,
    pullRequestNumber,
    github,
  });
  const push = (commit: string, pushedCommit?: string, pullRequestNumber?: number) =>
    pusher.push(input(commit, pushedCommit, pullRequestNumber));
  const openPullRequest = (commit: string) =>
    pusher.openPullRequest({
      ...input(commit),
      title: "Build (run 1)",
      body: "Opened from Halinka run 1.",
    });
  const openInRun = (
    commit: string,
    onPushed = async () => {},
    signal = new AbortController().signal,
  ) =>
    pusher.openPullRequestInRun(
      { ...input(commit), title: "Build (run 1)", body: "Opened from Halinka run 1." },
      signal,
      onPushed,
    );
  const remoteTip = async () => (await hostGit(bare).findBranch(branch)) ?? "";
  const deleteRemoteBranch = () => hostGit(bare).run("update-ref", "-d", `refs/heads/${branch}`);
  const commit = () => commitFile(repoPath, "a.txt");
  return {
    repoPath,
    pusher,
    input,
    mirrors,
    git,
    baseSha,
    gitHubFolderUrl,
    lent,
    locks,
    push,
    openPullRequest,
    openInRun,
    remoteTip,
    deleteRemoteBranch,
    commit,
  };
};

const noLogin: GitHubAuth = {
  token: () => Promise.reject(new Error("The runner must not use its login")),
};

const appAccess: GitHubAccess = { owner: "acme", name: "app", token: "ghs-action-token-1" };
const appHeader = Buffer.from(`x-access-token:${appAccess.token}`).toString("base64");

const setUpOverHttp = async (authorization: string) => {
  const gitHubFolder = await tempFolder();
  const server = await gitHttpServer(gitHubFolder, authorization);
  const repo = await setUp({
    auth: noLogin,
    github: appAccess,
    gitHubFolder,
    pushUrl: server.url,
  });
  return { server, ...repo };
};

const setUpMirror = async () => {
  const set = await setUp({ auth: noLogin, github: appAccess });
  const mirrorPath = set.mirrors.pathOf(100);
  await hostGit(set.repoPath).run("clone", "--quiet", "--bare", set.repoPath, mirrorPath);
  return { ...set, mirrorPlace: { repoPath: undefined, githubRepoId: 100 } };
};

const setUpLentCommit = async () => {
  const set = await setUp();
  set.lent.add("ANTHROPIC_API_KEY", "sk-secret-value-1");
  await writeFile(join(set.repoPath, "notes.txt"), "key: sk-secret-value-1\n");
  const tip = await commitAll(set.repoPath, "notes");
  return { ...set, push: () => set.push(tip) };
};

describe("BranchPusher", () => {
  it("pushes the branch from a bare clone to the repo that the server named", async () => {
    const { pusher, input, remoteTip, commit, repoPath, mirrors, mirrorPlace } =
      await setUpMirror();
    const tip = await commit();
    await hostGit(mirrors.pathOf(100)).run("fetch", "--quiet", repoPath, `${branch}:${branch}`);

    await pusher.push({ ...input(tip), ...mirrorPlace });

    expect(await remoteTip()).toBe(tip);
  });

  it("refuses a push from a mirror without a token", async () => {
    const { pusher, input, commit, mirrorPlace } = await setUpMirror();
    const tip = await commit();

    await expect(pusher.push({ ...input(tip), ...mirrorPlace, github: undefined })).rejects.toThrow(
      "needs a token of the App",
    );
  });

  it("pushes nothing from a mirror without a token", async () => {
    const { pusher, input, remoteTip, commit, mirrorPlace } = await setUpMirror();
    const tip = await commit();

    await pusher.push({ ...input(tip), ...mirrorPlace, github: undefined }).catch(() => {});

    expect(await remoteTip()).toBe("");
  });

  it("pushes with a token of the server to the named repo without the login of the runner", async () => {
    const { push, remoteTip, commit } = await setUp({ auth: noLogin, github: appAccess });
    const tip = await commit();

    await push(tip);

    expect(await remoteTip()).toBe(tip);
  });

  it("keeps the token out of the shared record", async () => {
    const { push, lent, commit } = await setUp({ auth: noLogin, github: appAccess });

    await push(await commit());

    expect(lent.find(appAccess.token)).toBeUndefined();
  });

  it("refuses a repo that differs from the origin", async () => {
    const github = { ...appAccess, name: "other" };
    const { push, commit } = await setUp({ auth: noLogin, github });

    await expect(push(await commit())).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("is acme/app, but its GitHub link is acme/other"),
    });
  });

  it("pushes nothing to a repo that differs from the origin", async () => {
    const github = { ...appAccess, name: "other" };
    const { push, remoteTip, commit } = await setUp({ auth: noLogin, github });

    await push(await commit()).catch(() => {});

    expect(await remoteTip()).toBe("");
  });

  it("accepts an origin with another case", async () => {
    const origin = "https://github.com/ACME/App.git";
    const { push, remoteTip, commit } = await setUp({ auth: noLogin, github: appAccess, origin });
    const tip = await commit();

    await push(tip);

    expect(await remoteTip()).toBe(tip);
  });

  it("masks the token in an error", async () => {
    const { push } = await setUp({ auth: noLogin, github: appAccess });

    await expect(push(appAccess.token)).rejects.toThrow('"***" is not a commit id');
  });

  it("masks the header of the token in an error", async () => {
    const { push } = await setUp({ auth: noLogin, github: appAccess });

    await expect(push(appHeader)).rejects.toThrow('"***" is not a commit id');
  });

  it("sends the token to GitHub", async () => {
    const api = await fakeGitHubApi();
    const { openPullRequest, commit } = await setUp({
      auth: noLogin,
      github: appAccess,
      apiUrl: api.url,
    });

    await openPullRequest(await commit());

    expect(api.requests.map(({ authorization }) => authorization)).toContain(
      `Bearer ${appAccess.token}`,
    );
  });

  it("masks the token in a pull request error", async () => {
    const { url } = await fakeGitHubApi({
      create: json({ message: `Bad ${appAccess.token}` }, 422),
    });
    const { openPullRequest, commit } = await setUp({
      auth: noLogin,
      github: appAccess,
      apiUrl: url,
    });

    expect(await openPullRequest(await commit())).toEqual({
      error: "GitHub answered 422: Bad ***",
    });
  });

  it("pushes the commit to the branch on GitHub", async () => {
    const { push, remoteTip, commit } = await setUp();
    const tip = await commit();

    await push(tip);

    expect(await remoteTip()).toBe(tip);
  });

  it("pushes again over the commit that the last push left", async () => {
    const { repoPath, push, remoteTip, commit } = await setUp();
    const first = await commit();
    await push(first);
    const second = await commitFile(repoPath, "b.txt");

    await push(second, first);

    expect(await remoteTip()).toBe(second);
  });

  it("refuses a push when another person changed the branch on GitHub", async () => {
    const { repoPath, git, baseSha, gitHubFolderUrl, push, remoteTip, commit } = await setUp();
    const first = await commit();
    await push(first);
    await git.run("switch", "--quiet", "-c", "other", baseSha);
    const other = await commitFile(repoPath, "other.txt");
    await git.run(
      "push",
      "--quiet",
      "--force",
      `${gitHubFolderUrl}/acme/app.git`,
      `other:${branch}`,
    );
    await git.run("switch", "--quiet", branch);
    const second = await commitFile(repoPath, "b.txt");

    await expect(push(second, first)).rejects.toMatchObject({ code: "conflict" });
    expect(await remoteTip()).toBe(other);
  });

  it.each([
    ["no stored commit", () => undefined],
    ["an older stored commit", (older: string) => older],
  ])("pushes over a commit of the run whose answer was lost, with %s", async (_, stored) => {
    const { repoPath, push, remoteTip, commit } = await setUp();
    const older = await commit();
    const lost = await commitFile(repoPath, "b.txt");
    await push(lost);
    const next = await commitFile(repoPath, "c.txt");

    await push(next, stored(older));

    expect(await remoteTip()).toBe(next);
  });

  it("refuses a branch on GitHub that Halinka never pushed, before git", async () => {
    const { git, baseSha, gitHubFolderUrl, push, remoteTip, commit } = await setUp();
    const url = `${gitHubFolderUrl}/acme/app.git`;
    await git.run("push", "--quiet", url, `${baseSha}:refs/heads/${branch}`);
    const tip = await commit();

    await expect(push(tip)).rejects.toMatchObject({
      code: "conflict",
      message: `The branch ${branch} is on GitHub, and Halinka stores no push of it. Change branch.name, or delete the branch on GitHub`,
    });
    expect(await remoteTip()).toBe(baseSha);
  });

  it("refuses the head of a pull request that moved after the run started", async () => {
    const { repoPath, git, baseSha, gitHubFolderUrl, push, remoteTip, commit } = await setUp();
    await git.run("switch", "--quiet", "-c", "other", baseSha);
    const moved = await commitFile(repoPath, "other.txt");
    await git.run(
      "push",
      "--quiet",
      `${gitHubFolderUrl}/acme/app.git`,
      `other:refs/heads/${branch}`,
    );
    await git.run("switch", "--quiet", branch);
    const tip = await commit();

    await expect(push(tip, undefined, 7)).rejects.toMatchObject({
      message:
        "The head of pull request #7 moved after the run started. Start a new run, or push the branch yourself",
    });
    expect(await remoteTip()).toBe(moved);
  });

  it("refuses a branch at the base of the run when the stored lease is stale", async () => {
    const { git, baseSha, gitHubFolderUrl, push, remoteTip, commit } = await setUp();
    const url = `${gitHubFolderUrl}/acme/app.git`;
    await git.run("push", "--quiet", url, `${baseSha}:refs/heads/${branch}`);
    const tip = await commit();

    await expect(push(tip, "a".repeat(40))).rejects.toMatchObject({ code: "conflict" });
    expect(await remoteTip()).toBe(baseSha);
  });

  it("pushes over the head of the pull request of a pull request run", async () => {
    const { git, baseSha, gitHubFolderUrl, push, remoteTip, commit } = await setUp();
    const url = `${gitHubFolderUrl}/acme/app.git`;
    await git.run("push", "--quiet", url, `${baseSha}:refs/heads/${branch}`);
    const tip = await commit();

    await push(tip, undefined, 7);

    expect(await remoteTip()).toBe(tip);
  });

  it("does not take a branch whose name only ends with the branch as the lease", async () => {
    const { git, gitHubFolderUrl, push, remoteTip, commit } = await setUp();
    const tip = await commit();
    const longer = `refs/heads/other/refs/heads/${branch}`;
    await git.run("push", "--quiet", `${gitHubFolderUrl}/acme/app.git`, `HEAD:${longer}`);

    await push(tip);

    expect(await remoteTip()).toBe(tip);
  });

  it("pushes a branch that GitHub deleted", async () => {
    const { repoPath, push, remoteTip, deleteRemoteBranch, commit } = await setUp();
    const first = await commit();
    await push(first);
    await deleteRemoteBranch();
    const second = await commitFile(repoPath, "b.txt");

    await push(second, first);

    expect(await remoteTip()).toBe(second);
  });

  it("refuses more than 1000 commits", async () => {
    const { repoPath, baseSha, push, remoteTip } = await setUp();
    const commitOf = (index: number) =>
      `commit refs/heads/${branch}\ncommitter A <a@a.test> ${index} +0000\ndata 1\nx\n`;
    const commits = Array.from({ length: 1001 }, (_, index) => commitOf(index));
    commits[0] += `from ${baseSha}\n`;
    execFileSync("git", ["fast-import", "--quiet"], { cwd: repoPath, input: commits.join("\n") });
    const tip = await hostGit(repoPath).run("rev-parse", branch);

    await expect(push(tip)).rejects.toMatchObject({
      message: "The run has more than 1000 commits. Push the branch yourself",
    });
    expect(await remoteTip()).toBe("");
  });

  it("refuses changes that are larger than 64 MiB", async () => {
    const { repoPath, push, remoteTip } = await setUp();
    await writeFile(join(repoPath, "large.txt"), "x".repeat(64 * 1024 * 1024));
    const tip = await commitAll(repoPath, "large");

    await expect(push(tip)).rejects.toMatchObject({
      code: "invalid_input",
      message: "The changes of the run are larger than 64 MiB. Push the branch yourself",
    });
    expect(await remoteTip()).toBe("");
  });

  it("gives only the token header to GitHub over http", async () => {
    const header = `Basic ${appHeader}`;
    const { server, push, remoteTip, commit } = await setUpOverHttp(header);
    const tip = await commit();

    await push(tip);

    expect(await remoteTip()).toBe(tip);
    expect(new Set(server.headers)).toEqual(new Set([header]));
  });

  it("does not ask a credential helper when GitHub refuses the token", async () => {
    const { git, push, commit } = await setUpOverHttp("Basic another-token");
    const asked = join(await tempFolder(), "asked");
    await git.run("config", "credential.helper", `!f() { touch "${asked}"; }; f`);

    await expect(push(await commit())).rejects.toMatchObject({ code: "conflict" });
    expect(existsSync(asked)).toBe(false);
  });

  it("refuses a branch whose tip is not the commit", async () => {
    const { repoPath, push, remoteTip, commit } = await setUp();
    const first = await commit();
    await commitFile(repoPath, "b.txt");

    await expect(push(first)).rejects.toMatchObject({ code: "conflict" });
    expect(await remoteTip()).toBe("");
  });

  it("refuses a commit that adds a lent value", async () => {
    const { push } = await setUpLentCommit();

    await expect(push()).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("contains the value of ANTHROPIC_API_KEY"),
    });
  });

  it("pushes nothing of a commit that adds a lent value", async () => {
    const { push, remoteTip } = await setUpLentCommit();

    await push().catch(() => {});

    expect(await remoteTip()).toBe("");
  });

  it("refuses a lent value in a commit that a later commit removes", async () => {
    const { repoPath, lent, push } = await setUp();
    lent.add("ANTHROPIC_API_KEY", "sk-secret-value-1");
    await writeFile(join(repoPath, "notes.txt"), "sk-secret-value-1\n");
    await commitAll(repoPath, "add");
    await writeFile(join(repoPath, "notes.txt"), "gone\n");
    const tip = await commitAll(repoPath, "remove");

    await expect(push(tip)).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses a lent value in a commit message", async () => {
    const { repoPath, lent, push } = await setUp();
    lent.add("ANTHROPIC_API_KEY", "sk-secret-value-1");
    await writeFile(join(repoPath, "notes.txt"), "text\n");
    const tip = await commitAll(repoPath, "key sk-secret-value-1");

    await expect(push(tip)).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses a commit that contains the GitHub token", async () => {
    const { repoPath, push } = await setUp();
    await writeFile(join(repoPath, "notes.txt"), "gho-test-token-1\n");
    const tip = await commitAll(repoPath, "notes");

    await expect(push(tip)).rejects.toMatchObject({
      message: expect.stringContaining("contains the value of GITHUB_TOKEN"),
    });
  });

  it("refuses a lent value in a file path", async () => {
    const { repoPath, lent, push } = await setUp();
    lent.add("ANTHROPIC_API_KEY", "sk-secret-value-1");
    const tip = await commitFile(repoPath, "sk-secret-value-1.txt");

    await expect(push(tip)).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses a lent value in a binary file", async () => {
    const { repoPath, lent, push } = await setUp();
    lent.add("ANTHROPIC_API_KEY", "sk-secret-value-1");
    await writeFile(join(repoPath, "data.bin"), Buffer.from("\0\0sk-secret-value-1\0"));
    const tip = await commitAll(repoPath, "data");

    await expect(push(tip)).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses a commit that contains the token header", async () => {
    const { repoPath, push } = await setUp();
    const header = Buffer.from("x-access-token:gho-test-token-1").toString("base64");
    await writeFile(join(repoPath, "notes.txt"), `${header}\n`);
    const tip = await commitAll(repoPath, "notes");

    await expect(push(tip)).rejects.toMatchObject({ code: "conflict" });
  });

  it("pushes over https for an ssh origin", async () => {
    const { push, remoteTip, commit } = await setUp({ origin: "git@github.com:acme/app.git" });
    const tip = await commit();

    await push(tip);

    expect(await remoteTip()).toBe(tip);
  });

  it("refuses a pushed commit that is not a commit id", async () => {
    const { push, commit } = await setUp();

    await expect(push(await commit(), "--upload-pack=x")).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("refuses a repo without an origin", async () => {
    const { repoPath, push, commit } = await setUp();
    await hostGit(repoPath).run("remote", "remove", "origin");

    await expect(push(await commit())).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("frees the run's workspace lock after a refused push", async () => {
    const { repoPath, locks, push, commit } = await setUp();
    await hostGit(repoPath).run("remote", "remove", "origin");
    await push(await commit()).catch(() => {});

    expect(await locks.tryTake(runFolderName(1))).toBeTypeOf("function");
  });

  it("refuses a push that a url rewrite in the git config changes", async () => {
    const { git, gitHubFolderUrl, push, remoteTip, commit } = await setUp();
    await git.run("config", "url.ssh://git@elsewhere/.insteadOf", `${gitHubFolderUrl}/`);

    await expect(push(await commit())).rejects.toMatchObject({ code: "conflict" });
    expect(await remoteTip()).toBe("");
  });

  it("pushes only to the GitHub repo, not to a push URL of the origin", async () => {
    const { git, push, commit } = await setUp();
    const other = await tempFolder();
    await hostGit(other).run("init", "--quiet", "--bare");
    await git.run("config", "remote.origin.pushurl", other);

    await push(await commit());

    expect(await hostGit(other).findBranch(branch)).toBeUndefined();
  });

  it("refuses an origin that is not on github.com", async () => {
    const { push, commit } = await setUp({ origin: "https://gitlab.com/acme/app.git" });

    await expect(push(await commit())).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses a push while the run executes", async () => {
    const { locks, push, commit } = await setUp();
    const tip = await commit();
    await locks.tryTake(runFolderName(1));

    await expect(push(tip)).rejects.toMatchObject({
      code: "conflict",
      message: "Run 1 is executing, or its branch is being pushed. Try again later",
    });
  });

  it("waits for a lock that another task holds for a moment", async () => {
    const { locks, push, commit, remoteTip } = await setUp({ lockTimeoutMs: 30_000 });
    const tip = await commit();
    const release = await locks.tryTake(runFolderName(1));

    const pushed = push(tip);
    await release?.();
    await pushed;

    expect(await remoteTip()).toBe(tip);
  });

  it("stops at the deadline with a message", async () => {
    const hangs: GitHubAuth = {
      token: (signal) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    };
    const { push, commit } = await setUp({ auth: hangs, timeoutMs: 50 });

    await expect(push(await commit())).rejects.toMatchObject({
      code: "conflict",
      message: "The push took more than 0.05 s. Push the branch yourself",
    });
  });

  it("opens a draft pull request into the default branch after the push", async () => {
    const api = await fakeGitHubApi();
    const { openPullRequest, commit } = await setUp({ apiUrl: api.url });

    expect(await openPullRequest(await commit())).toEqual({
      url: "https://github.com/acme/app/pull/7",
      isCreated: true,
    });
    expect(api.requests.at(-1)).toMatchObject({
      method: "POST",
      body: { head: branch, base: "main", draft: true, title: "Build (run 1)" },
    });
  });

  it("sends the token of the runner user to GitHub", async () => {
    const api = await fakeGitHubApi();
    const { openPullRequest, commit } = await setUp({ apiUrl: api.url });

    await openPullRequest(await commit());

    expect(api.requests.map(({ authorization }) => authorization)).toContain(
      "Bearer gho-test-token-1",
    );
  });

  it("gives the open pull request of the branch", async () => {
    const pull = {
      html_url: "https://github.com/acme/app/pull/3",
      base: { ref: "main" },
      head: { ref: branch },
    };
    const api = await fakeGitHubApi({ pulls: json([pull]) });
    const { openPullRequest, commit } = await setUp({ apiUrl: api.url });

    expect(await openPullRequest(await commit())).toEqual({ url: pull.html_url, isCreated: false });
    expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toContain(
      `GET /repos/acme/app/pulls?state=open&per_page=1&head=${encodeURIComponent(`acme:${branch}`)}`,
    );
    expect(api.requests.some(({ method }) => method === "POST")).toBe(false);
  });

  it("refuses a pull request when the base of the run is not on its base branch", async () => {
    const api = await fakeGitHubApi({ compare: json({ status: "diverged" }) });
    const { openPullRequest, baseSha, commit } = await setUp({ apiUrl: api.url });

    expect(await openPullRequest(await commit())).toEqual({
      error: `The base ${baseSha.slice(0, 7)} of the run is not on main. Push it first`,
    });
    expect(api.requests.some(({ method }) => method === "POST")).toBe(false);
  });

  it("answers an error when GitHub does not answer before the deadline", async () => {
    const api = await fakeGitHubApi({ create: { ...json({}), hangs: true } });
    const { openPullRequest, commit } = await setUp({
      apiUrl: api.url,
      timeoutMs: 3000,
    });

    expect(await openPullRequest(await commit())).toEqual({
      error: "GitHub did not answer in 3 s",
    });
  });

  it("answers the error of GitHub after a successful push", async () => {
    const failed = { message: "Validation Failed", errors: [{ message: "No drafts here" }] };
    const api = await fakeGitHubApi({ create: json(failed, 422) });
    const { openPullRequest, remoteTip, commit } = await setUp({ apiUrl: api.url });
    const tip = await commit();

    expect(await openPullRequest(tip)).toEqual({
      error: "GitHub answered 422: Validation Failed: No drafts here",
    });
    expect(await remoteTip()).toBe(tip);
  });

  it("masks a lent value in the error of GitHub", async () => {
    const api = await fakeGitHubApi({ create: json({ message: "bad sk-secret-value-1" }, 422) });
    const { lent, openPullRequest, commit } = await setUp({ apiUrl: api.url });
    lent.add("ANTHROPIC_API_KEY", "sk-secret-value-1");

    expect(await openPullRequest(await commit())).toEqual({
      error: "GitHub answered 422: bad ***",
    });
  });

  it("answers the status of GitHub when the error is not JSON", async () => {
    const api = await fakeGitHubApi({ create: { status: 502, body: "upstream down" } });
    const { openPullRequest, commit } = await setUp({ apiUrl: api.url });

    expect(await openPullRequest(await commit())).toEqual({
      error: "GitHub answered 502: Bad Gateway",
    });
  });

  it("answers an error when GitHub gives a pull request without a URL", async () => {
    const api = await fakeGitHubApi({ create: json({}, 201) });
    const { openPullRequest, commit } = await setUp({ apiUrl: api.url });

    expect(await openPullRequest(await commit())).toEqual({
      error: "GitHub answered a pull request without a URL of this repo",
    });
  });

  it("answers an error when GitHub gives a pull request of another repo", async () => {
    const api = await fakeGitHubApi({
      create: json({ html_url: "https://evil.test/acme/app/pull/1" }, 201),
    });
    const { openPullRequest, commit } = await setUp({ apiUrl: api.url });

    expect(await openPullRequest(await commit())).toEqual({
      error: "GitHub answered a pull request without a URL of this repo",
    });
  });

  it("refuses an open pull request of another branch", async () => {
    const pull = {
      html_url: "https://github.com/acme/app/pull/3",
      base: { ref: "main" },
      head: { ref: "x" },
    };
    const api = await fakeGitHubApi({ pulls: json([pull]) });
    const { openPullRequest, commit } = await setUp({ apiUrl: api.url });

    expect(await openPullRequest(await commit())).toEqual({
      error: "GitHub answered a pull request of another branch",
    });
  });

  it("calls GitHub only after a successful push", async () => {
    const api = await fakeGitHubApi();
    const { openPullRequest, commit } = await setUp({
      apiUrl: api.url,
      origin: "https://gitlab.com/acme/app.git",
    });

    await expect(openPullRequest(await commit())).rejects.toMatchObject({ code: "invalid_input" });
    expect(api.requests).toEqual([]);
  });

  it("opens the pull request while the engine holds the lock", async () => {
    const api = await fakeGitHubApi();
    const { locks, openInRun, commit } = await setUp({ apiUrl: api.url });
    const tip = await commit();
    await locks.tryTake(runFolderName(1));

    expect(await openInRun(tip)).toEqual({
      url: "https://github.com/acme/app/pull/7",
      isCreated: true,
    });
  });

  it("pushes the branch of a pull request while the engine holds the lock", async () => {
    const api = await fakeGitHubApi();
    const { locks, openInRun, remoteTip, commit } = await setUp({ apiUrl: api.url });
    const tip = await commit();
    await locks.tryTake(runFolderName(1));

    await openInRun(tip);

    expect(await remoteTip()).toBe(tip);
  });

  it("stores the push before it asks GitHub for the pull request", async () => {
    const api = await fakeGitHubApi();
    const { openInRun, commit } = await setUp({ apiUrl: api.url });
    let requestsAtStore = -1;

    await openInRun(await commit(), async () => {
      requestsAtStore = api.requests.length;
    });

    expect(requestsAtStore).toBe(0);
  });

  it("stores the push when the pull request then fails", async () => {
    const api = await fakeGitHubApi({ create: json({ message: "Refused" }, 422) });
    const { openInRun, commit } = await setUp({ apiUrl: api.url });
    const onPushed = vi.fn(async () => {});

    await openInRun(await commit(), onPushed);

    expect(onPushed).toHaveBeenCalledOnce();
  });

  it("opens no pull request when the store fails", async () => {
    const api = await fakeGitHubApi();
    const { openInRun, commit } = await setUp({ apiUrl: api.url });

    await expect(
      openInRun(await commit(), () => Promise.reject(new Error("The lease is lost"))),
    ).rejects.toThrow("The lease is lost");
    expect(api.requests).toEqual([]);
  });

  it("masks the token in an answer", async () => {
    const { url } = await fakeGitHubApi({
      create: json({ message: `Bad ${appAccess.token}` }, 422),
    });
    const { openInRun, commit } = await setUp({ auth: noLogin, github: appAccess, apiUrl: url });

    expect(await openInRun(await commit())).toEqual({ error: "GitHub answered 422: Bad ***" });
  });

  it("refuses at once when the run has stopped", async () => {
    const { openInRun, commit, remoteTip } = await setUp();

    await expect(openInRun(await commit(), undefined, AbortSignal.abort())).rejects.toThrow();
    expect(await remoteTip()).toBe("");
  });

  it("gives no answer of GitHub after the run stopped", async () => {
    const api = await fakeGitHubApi({ create: { ...json({}), hangs: true } });
    const { openInRun, commit } = await setUp({ apiUrl: api.url });
    const run = new AbortController();
    const tip = await commit();

    const opened = openInRun(
      tip,
      async () => {
        setTimeout(() => run.abort(), 50);
      },
      run.signal,
    );

    await expect(opened).rejects.toThrow();
  });
});
