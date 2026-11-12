import { join } from "node:path";

import { conflict, type GitHubAccess, invalidInput } from "@halinka/protocol";
import { HostSandbox, hostGit } from "@halinka/sandbox/host";
import { errorMessage } from "@halinka/utils/errors";
import { ensureFolder } from "@halinka/utils/fs";
import { Git, isCommitId } from "@halinka/utils/git";

import { actionMask, requireNoUrlRewrite, repoUrlOf, tokenGitConfig } from "./github";
import { maskedError } from "./maskingCommands";

type CommitFetch = {
  githubRepoId: number;
  commit: string;
  groupsFile: string;
  readAccess: () => Promise<GitHubAccess>;
  signal: AbortSignal;
};

// One bare repository per GitHub repo, with no remote and no stored token.
export class GitHubMirrors {
  private readonly created = new Map<number, Promise<unknown>>();

  constructor(
    private readonly folder: string,
    private readonly gitHubUrl = "https://github.com",
  ) {}

  // The server gives the id, and no transport checks it: it becomes a path.
  pathOf(githubRepoId: number) {
    if (!Number.isSafeInteger(githubRepoId)) {
      throw new Error("The server gave a GitHub repo id that is not a number");
    }
    return join(this.folder, `${githubRepoId}.git`);
  }

  // Runs of one repo start at the same time, and two `git init` can fail on the config lock.
  private create(githubRepoId: number, path: string) {
    const creating =
      this.created.get(githubRepoId) ??
      ensureFolder(this.folder).then(() =>
        // No template: no hook samples.
        hostGit(this.folder).run("init", "--quiet", "--bare", "--template=", path),
      );
    this.created.set(githubRepoId, creating);
    return creating.catch((error: unknown) => {
      this.created.delete(githubRepoId);
      throw error;
    });
  }

  // The run builds from one commit, and its code starts from the other.
  async ensureCommits({
    commits,
    ...options
  }: Omit<CommitFetch, "commit"> & { commits: string[] }) {
    for (const commit of commits) await this.ensureCommit({ ...options, commit });
    return this.pathOf(options.githubRepoId);
  }

  private async ensureCommit({
    githubRepoId,
    commit,
    groupsFile,
    readAccess,
    signal,
  }: CommitFetch) {
    if (!isCommitId(commit)) throw invalidInput(`"${commit}" is not a commit id`);
    const path = this.pathOf(githubRepoId);
    await this.create(githubRepoId, path);
    const git = new Git(new HostSandbox(path, groupsFile), {}, { signal });
    if (await git.findCommit(commit)) return;
    const access = await readAccess();
    const url = repoUrlOf(this.gitHubUrl, access);
    await requireNoUrlRewrite(git, url, "Halinka does not fetch from it");
    await git
      .fetchCommit(url, commit, tokenGitConfig(this.gitHubUrl, access.token))
      .catch((error: unknown) => {
        throw maskedError(
          conflict(`Git could not fetch ${commit} from GitHub: ${errorMessage(error)}`),
          actionMask(access.token),
        );
      });
  }
}
