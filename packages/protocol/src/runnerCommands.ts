import { methodsOf } from "./methods";

// The server stops waiting for a command after this.
export const commandTimeoutMs = 60_000;

// What the server asks of a connected runner. A command never waits for a run.
export type RunnerCommands = {
  // queued work may wait for this runner: claim now instead of at the next poll
  wake: () => Promise<void>;
  readRepo: (input: { repoPath: string }) => Promise<RepoRead>;
  // only a file under `.halinka/`
  writeRepoFile: (input: RepoFileWrite) => Promise<{ hash: string }>;
  // regular files only
  readCommitFile: (input: CommitFileRead) => Promise<{ source: string } | undefined>;
  // `path` undefined: the home folder of the runner user
  listFolders: (input: { path?: string }) => Promise<FolderListing>;
  // the devcontainer.json files of the repo, by path from the repo root
  listDevcontainers: (input: { repoPath: string }) => Promise<string[]>;
  // writes the scaffold of `halinka init`
  setUpRepo: (input: RepoSetupWrite) => Promise<{ files: string[] }>;
  // only to a github.com origin
  pushBranch: (input: BranchPush) => Promise<void>;
  // pushes first; a failed push throws
  openPullRequest: (input: PullRequestOpen) => Promise<PullRequestAnswer>;
  // answers after the accept of a new socket
  openRelay: (input: RelayOpen) => Promise<void>;
};

export const runnerCommandMethods = methodsOf<RunnerCommands>({
  wake: true,
  readRepo: true,
  writeRepoFile: true,
  readCommitFile: true,
  listFolders: true,
  listDevcontainers: true,
  setUpRepo: true,
  pushBranch: true,
  openPullRequest: true,
  openRelay: true,
});

export type RelayOpen = { relayId: string; workflowRunId: number };

export type RepoRead = {
  realPath: string;
  head: string;
  // every file under `.halinka/` by repo-relative path
  files: Record<string, RepoFile>;
};

export type RepoFile = {
  source: string;
  // SHA-256 hex of the file's bytes
  hash: string;
};

export type RepoFileWrite = {
  repoPath: string;
  path: string;
  source: string;
  // undefined: the file must not exist yet
  expectedHash?: string;
};

export type Folder = { name: string; path: string; isRepo: boolean };

export type FolderListing = {
  path: string;
  // undefined at the root
  parent?: string;
  isRepo: boolean;
  // sorted by name, without hidden folders
  folders: Folder[];
  isTruncated: boolean;
};

export type RepoSetupWrite = {
  repoPath: string;
  // `local` or the URL of the server
  server: string;
  // one of `listDevcontainers`, `newDevcontainerPath` to create it, or undefined for none
  devcontainer?: string;
};

export type GitHubAccess = { owner: string; name: string; token: string };

export const repoKinds = ["local", "github"] as const;

// A checkout on the runner, or the mirror of a GitHub repo that the runner keeps.
export type RepoPlace =
  | { repoPath: string; githubRepoId?: undefined }
  | { repoPath?: undefined; githubRepoId: number };

export type BranchPush = RepoPlace & {
  workflowRunId: number;
  branch: string;
  // the run's commits are `baseSha..commit`
  baseSha: string;
  commit: string;
  // undefined: the branch must not exist on GitHub
  pushedCommit?: string;
  // set: a tip at `baseSha` is the lease, as the head of this pull request
  pullRequestNumber?: number;
  // none: the `gh` login of the runner, for the repo of the origin; a mirror refuses none
  github?: GitHubAccess | undefined;
};

export type PullRequestOpen = BranchPush & { title: string; body: string };

// `error`: the push succeeded, the pull request failed
export type PullRequestAnswer = { url: string; isCreated: boolean } | { error: string };

// `path`: from the repo root
export type CommitFileRead = { repoPath: string; commit: string; path: string };
