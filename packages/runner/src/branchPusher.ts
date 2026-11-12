import {
  type BranchPush,
  codeOf,
  commandTimeoutMs,
  conflict,
  type GitHubAccess,
  invalidInput,
  type PullRequestAnswer,
  type PullRequestOpen,
} from "@halinka/protocol";
import { outputLimitCode } from "@halinka/sandbox";
import { HostSandbox, hostGit, stopLeftoverGroups } from "@halinka/sandbox/host";
import { errorMessage } from "@halinka/utils/errors";
import type { FileLocks } from "@halinka/utils/fileLocks";
import { Git, isCommitId, shortSha } from "@halinka/utils/git";

import {
  actionMask,
  addToken,
  type GitHubAuth,
  type GitHubRepo,
  openPullRequest,
  postComment,
  parseGitHubRemote,
  requireNoUrlRewrite,
  repoUrlOf,
  tokenGitConfig,
} from "./github";
import type { GitHubMirrors } from "./githubMirrors";
import type { LentValues } from "./lentValues";
import { maskedError } from "./maskingCommands";
import { requireAbsolute } from "./repoFiles";
import { type Workspaces, runFolderName } from "./workspaces";

const maxCommits = 1000;
const maxOutputChars = 64 * 1024 * 1024;
// The runner answers before the server stops waiting.
const pushTimeoutMs = commandTimeoutMs - 10_000;
// A sandbox apply holds the lock for a moment. It is less than the margin of `pushTimeoutMs`.
const lockTimeoutMs = 3000;

export type BranchPusherOptions = {
  locks: Pick<FileLocks, "take">;
  workspaces: Pick<Workspaces, "groupsFileOf">;
  mirrors: Pick<GitHubMirrors, "pathOf">;
  lent: Pick<LentValues, "add" | "find" | "mask">;
  auth: GitHubAuth;
  // `gitHubUrl` and `apiUrl`: other values only in tests
  gitHubUrl?: string;
  apiUrl?: string;
  timeoutMs?: number;
  lockTimeoutMs?: number;
};

const fullName = ({ owner, name }: GitHubRepo) => `${owner}/${name}`;

const checkoutTarget = (remote: string | undefined, repoPath: string, github?: GitHubAccess) => {
  const origin = remote && parseGitHubRemote(remote);
  if (!origin) throw invalidInput(`The origin of ${repoPath} is not a repo on github.com`);
  const repo = github ? { owner: github.owner, name: github.name } : origin;
  // A wrong link must not send the code of this checkout to another repo.
  if (fullName(origin).toLowerCase() !== fullName(repo).toLowerCase()) {
    throw conflict(
      `The origin of ${repoPath} is ${fullName(origin)}, but its GitHub link is ${fullName(repo)}. Change the origin or the link`,
    );
  }
  return repo;
};

// The stored lease can be behind GitHub (a lost answer, a deleted branch).
const leaseOf = (
  { branch, baseSha, pushedCommit, pullRequestNumber }: BranchPush,
  remoteTip: string | undefined,
  runCommits: string[],
) => {
  if (remoteTip === undefined) return undefined;
  // Only a pull request run owns a branch tip at the base.
  const ownsBase = pullRequestNumber !== undefined && remoteTip === baseSha;
  if (ownsBase || runCommits.includes(remoteTip)) return remoteTip;
  if (pushedCommit !== undefined) return pushedCommit;
  throw conflict(
    pullRequestNumber === undefined
      ? `The branch ${branch} is on GitHub, and Halinka stores no push of it. Change branch.name, or delete the branch on GitHub`
      : `The head of pull request #${pullRequestNumber} moved after the run started. Start a new run, or push the branch yourself`,
  );
};

export class BranchPusher {
  private readonly options: Required<BranchPusherOptions>;

  constructor(options: BranchPusherOptions) {
    this.options = {
      gitHubUrl: "https://github.com",
      apiUrl: "https://api.github.com",
      timeoutMs: pushTimeoutMs,
      lockTimeoutMs,
      ...options,
    };
  }

  async push(input: BranchPush) {
    await this.withinLock(input, (signal) => this.pushWithin(input, signal));
  }

  // Answer a pull request error, so that the server stores the push.
  openPullRequest(input: PullRequestOpen): Promise<PullRequestAnswer> {
    return this.withinLock(input, (signal) => this.pushAndOpen(input, signal));
  }

  async postComment(
    { pullRequestNumber, github }: { pullRequestNumber: number; github: GitHubAccess },
    text: string,
    signal: AbortSignal,
  ): Promise<{ url: string } | { error: string }> {
    const call = { apiUrl: this.options.apiUrl, token: github.token, signal };
    try {
      return { url: await postComment(call, github, { pullRequestNumber, text }) };
    } catch (error) {
      signal.throwIfAborted();
      return { error: actionMask(github.token).mask(errorMessage(error)) };
    }
  }

  // The engine holds the lock; `onPushed` stores the push before the pull request can fail.
  async openPullRequestInRun(
    input: PullRequestOpen,
    signal: AbortSignal,
    onPushed: () => Promise<void>,
  ): Promise<PullRequestAnswer> {
    const answer = await this.masked(input, () => this.pushAndOpen(input, signal, onPushed));
    signal.throwIfAborted();
    return answer;
  }

  private async pushAndOpen(
    input: PullRequestOpen,
    signal: AbortSignal,
    onPushed?: () => Promise<void>,
  ) {
    const { repo, token } = await this.pushWithin(input, signal);
    await onPushed?.();
    const call = { apiUrl: this.options.apiUrl, token, signal };
    return openPullRequest(call, repo, input).catch((error: unknown) => ({
      error: signal.aborted
        ? `GitHub did not answer in ${this.options.timeoutMs / 1000} s`
        : this.options.lent.mask(errorMessage(error)),
    }));
  }

  private async withinLock<T>(input: BranchPush, action: (signal: AbortSignal) => Promise<T>) {
    const { workflowRunId } = input;
    const wait = AbortSignal.timeout(this.options.lockTimeoutMs);
    const release = await this.options.locks
      .take(runFolderName(workflowRunId), wait)
      .catch((error: unknown) => {
        if (!wait.aborted) throw error;
      });
    if (!release) {
      throw conflict(
        `Run ${workflowRunId} is executing, or its branch is being pushed. Try again later`,
      );
    }
    const signal = AbortSignal.timeout(this.options.timeoutMs);
    try {
      return await this.masked(input, () => action(signal));
    } catch (error) {
      if (!signal.aborted) throw error;
      throw conflict(
        `The push took more than ${this.options.timeoutMs / 1000} s. Push the branch yourself`,
      );
    } finally {
      // The answer wins: a push that went through must reach the server.
      await release().catch((error: unknown) => {
        console.error(`Halinka could not free the workspace lock of run ${workflowRunId}`, error);
      });
    }
  }

  private async masked<T>({ github }: BranchPush, action: () => Promise<T>) {
    const mask = actionMask(github?.token);
    try {
      return mask.mask(await action());
    } catch (error) {
      throw maskedError(error, mask);
    }
  }

  private async pushWithin(input: BranchPush, signal: AbortSignal) {
    const { workflowRunId, branch, baseSha, commit, pushedCommit, github } = input;
    for (const value of [baseSha, commit, ...(pushedCommit ? [pushedCommit] : [])]) {
      if (!isCommitId(value)) throw invalidInput(`"${value}" is not a commit id`);
    }
    const isMirror = input.githubRepoId !== undefined;
    if (isMirror && !github) throw invalidInput("A GitHub repo needs a token of the App");
    const repoPath = isMirror ? this.options.mirrors.pathOf(input.githubRepoId) : input.repoPath;
    requireAbsolute(repoPath);
    // A process that a crashed push left can still write to the checkout.
    const groupsFile = this.options.workspaces.groupsFileOf(workflowRunId);
    await stopLeftoverGroups(groupsFile);
    const git = hostGit(repoPath, undefined, { signal });
    // A mirror has no root.
    if (!isMirror && !(await git.findRoot())) throw invalidInput(`${repoPath} is not a git repo`);
    if ((await git.findBranch(branch)) !== commit)
      throw conflict(`The branch ${branch} moved after the server read it. Try again`);
    const repo =
      isMirror && github
        ? github
        : checkoutTarget(await git.findRemoteUrl("origin"), repoPath, github);
    const url = repoUrlOf(this.options.gitHubUrl, repo);
    await requireNoUrlRewrite(git, url, "Push the branch yourself");
    const token = github?.token ?? (await this.loginToken(signal));
    const runCommits = await this.scan(git, baseSha, commit);
    const config = tokenGitConfig(this.options.gitHubUrl, token);
    const remoteGit = new Git(new HostSandbox(repoPath, groupsFile), {}, { signal });
    const gitFailed = (error: unknown): never => {
      throw conflict(`Git could not push ${branch}: ${errorMessage(error)}`);
    };
    const remoteTip = await remoteGit.findRemoteBranch(url, branch, config).catch(gitFailed);
    const lease = leaseOf(input, remoteTip, runCommits);
    await remoteGit
      .pushCommit(url, commit, { branch, expected: lease, hiddenConfig: config })
      .catch(gitFailed);
    return { repo, token };
  }

  // A lent value: a worktree agent can read this token.
  private async loginToken(signal: AbortSignal) {
    const token = await this.options.auth.token(signal);
    addToken(this.options.lent, token);
    return token;
  }

  // Each commit: a later commit can remove a value that an earlier commit added.
  private async scan(git: Git, baseSha: string, commit: string) {
    const commits = await git
      .listCommitChanges(baseSha, commit, { maxCount: maxCommits + 1, maxOutputChars })
      .catch((error: Error) => {
        if (codeOf(error.cause) !== outputLimitCode) throw error;
        throw invalidInput(
          "The changes of the run are larger than 64 MiB. Push the branch yourself",
        );
      });
    if (commits.length > maxCommits) {
      throw invalidInput(`The run has more than ${maxCommits} commits. Push the branch yourself`);
    }
    for (const { commit: sha, message, changes } of commits) {
      const name = this.options.lent.find(message) ?? this.options.lent.find(changes);
      if (name) {
        throw conflict(
          `The commit ${shortSha(sha)} contains the value of ${name}. Halinka does not push a lent credential`,
        );
      }
    }
    return commits.map(({ commit: sha }) => sha);
  }
}
