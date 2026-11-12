import { createWriteStream } from "node:fs";
import { copyFile, lstat, open, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Writable } from "node:stream";

import type {
  ClaimedRun,
  RepoPlace,
  Rewind,
  RunBranch,
  SandboxState,
  SandboxTarget,
} from "@halinka/protocol";
import { type Sandbox, sandboxGitTimeoutMs } from "@halinka/sandbox";
import { HostSandbox, stopLeftoverGroups } from "@halinka/sandbox/host";
import { ensureFolder, findRealPath, pathExists, readTextFile } from "@halinka/utils/fs";
import { Git, halinkaIdentity, isCommitId, noHostConfig, shortSha } from "@halinka/utils/git";
import { SerialQueue } from "@halinka/utils/serialQueue";

// The runner works on this path, for a checkout and for a mirror.
export type Located<T extends RepoPlace> = T extends RepoPlace
  ? Omit<T, keyof RepoPlace> & { repoPath: string; isMirror: boolean }
  : never;

type LocatedRun = Located<ClaimedRun>;

const requireValidBranch = async (repo: Git, run: LocatedRun) => {
  const { repoPath, branch, baseSha, steps, lastCheckpoint } = run;
  const tip = await repo.findBranch(branch);
  if (steps.length > 0) {
    if (!tip) throw new Error(`The branch ${branch} is missing in ${repoPath}`);
  } else if (tip && tip !== baseSha) {
    throw new Error(
      `The branch ${branch} in ${repoPath} is at another commit than the base of the run. Delete the branch, or use another branch name.`,
    );
  }
  if (!tip || tip === lastCheckpoint) return tip;
  if (!(await repo.findCommit(lastCheckpoint))) {
    throw new Error(`The last checkpoint ${lastCheckpoint} of ${branch} is missing in ${repoPath}`);
  }
  if (!(await repo.isAncestor(lastCheckpoint, tip))) {
    throw new Error(`The branch ${branch} in ${repoPath} moved away from its last checkpoint`);
  }
  return tip;
};

// A checkout keeps a branch that can be the only copy. No person reads a mirror.
const deleteRunBranch = async (repo: Git, runBranch: RunBranch | undefined) => {
  if (!runBranch) return;
  const { name, lastCheckpoint } = runBranch;
  if ((await repo.findBranch(name)) !== lastCheckpoint) return;
  if ((await repo.listWorktrees()).some(({ branch }) => branch === name)) return;
  if ((await repo.isBare()) || (await repo.isHeldOutsideBranch(lastCheckpoint, name))) {
    await repo.deleteBranch(name, lastCheckpoint);
  }
};

// Find the worktree by its folder: the agent can detach it or change its branch.
const isRunWorktree = async (repo: Git, realFolder: string, branch: string) => {
  const worktrees = await repo.listWorktrees();
  const realPaths = await Promise.all(
    worktrees.map(async (worktree) =>
      worktree.isPrunable ? undefined : findRealPath(worktree.path),
    ),
  );
  const own = worktrees.find((_, index) => realPaths[index] === realFolder);
  const holder = worktrees.find((worktree) => worktree.branch === branch);
  return own !== undefined && (holder === undefined || holder === own);
};

// A worktree shows false changes when `update-ref` moves its branch.
const requireNotCheckedOut = async (repo: Git, { repoPath, branch }: LocatedRun) => {
  const holder = (await repo.listWorktrees()).find(
    (worktree) => worktree.branch === branch && !worktree.isPrunable,
  );
  if (holder) {
    throw new Error(
      `The branch ${branch} of ${repoPath} is checked out in ${holder.path}. Check out another branch there.`,
    );
  }
};

const hasGitFolder = (folder: string) =>
  lstat(join(folder, ".git")).then(
    (stats) => stats.isDirectory(),
    () => false,
  );

const bundleTimeoutMs = 10 * 60 * 1000;
const maxBundleHeaderBytes = 64 * 1024;

// Host git never reads the clone: the container can change its files.
const sandboxGit = (sandbox: Sandbox, config: Record<string, string> = {}) =>
  new Git(sandbox, config, {
    timeoutMs: sandboxGitTimeoutMs,
    workTree: sandbox.workspaceFolder,
  });

type BundleOptions = { commit: string; exclude: string };

const writeBundle = async (sandbox: Sandbox, file: string, { commit, exclude }: BundleOptions) => {
  const command = await sandboxGit(sandbox).prepareBundle(commit, exclude);
  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(bundleTimeoutMs)]);
  const bundle = await sandbox.spawn(command, { signal });
  try {
    await bundle.stdin.close();
    const [, stderr, exitCode] = await Promise.all([
      bundle.stdout.pipeTo(Writable.toWeb(createWriteStream(file))),
      new Response(bundle.stderr).text(),
      bundle.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`git bundle failed with exit code ${exitCode}: ${stderr.trim()}`);
    }
  } finally {
    stop.abort();
    await bundle.stopped;
  }
};

// A gitfile makes `fetch` read a repository, and a `@filter` bundle leaves a promisor pack.
const requirePlainBundle = async (file: string) => {
  const handle = await open(file);
  let read;
  try {
    read = await handle.read(Buffer.alloc(maxBundleHeaderBytes), 0, maxBundleHeaderBytes, 0);
  } finally {
    await handle.close();
  }
  const text = read.buffer.subarray(0, read.bytesRead).toString("utf8");
  // The last line can be cut, so only complete lines count.
  const [version, ...lines] = text.split("\n").slice(0, -1);
  const end = lines.findIndex((line) => !line.startsWith("@"));
  const capabilities = lines.slice(0, end);
  const isPlain =
    end !== -1 &&
    (version === "# v2 git bundle" ||
      (version === "# v3 git bundle" &&
        capabilities.every((capability) => capability.startsWith("@object-format="))));
  if (!isPlain) throw new Error("The checkpoint bundle from the sandbox is not a plain git bundle");
};

const findLockFiles = async (git: Git, branch: string) => {
  const { gitFolder, commonFolder } = await git.findGitFolders();
  return [join(gitFolder, "index.lock"), join(commonFolder, "refs", "heads", `${branch}.lock`)];
};

type RewindOptions = { tip: string; rewind: Rewind; supersededRef: string };

// A rewind with `hasLaterAttempts` deletes the uncommitted files, so keep them in the superseded ref.
const tipWithChanges = async (
  git: Git,
  run: LocatedRun,
  { tip, rewind, supersededRef }: RewindOptions,
) => {
  const kept = await git.findCommit(supersededRef);
  if (kept) return kept;
  if (!rewind.hasLaterAttempts) return tip;
  // `restoreBranch` attaches HEAD and clears the index flags that hide changes.
  await git.restoreBranch(run.branch, tip);
  if ((await git.listChanges()).length === 0) return tip;
  await git.addAll();
  return git.commitIndex(tip, "Changes before the reopen");
};

// A repeat after a crash keeps the first tip in the ref.
const rewindBranch = async (
  git: Git,
  run: LocatedRun,
  { tip, rewind, supersededRef }: RewindOptions,
) => {
  const { before, after, hasLaterAttempts } = rewind;
  const { branch } = run;
  await git.createRef(supersededRef, tip);
  if (hasLaterAttempts) {
    await git.restoreBranch(branch, after);
    await git.discardChanges();
  }
  await git.restoreBranch(branch, before);
};

type FetchFromCloneOptions = BundleOptions & { sandbox: Sandbox };

export const runFolderName = (workflowRunId: number) => {
  if (!Number.isSafeInteger(workflowRunId)) {
    throw new Error("The server gave a run id that is not a number");
  }
  return `run-${workflowRunId}`;
};

export class Workspaces {
  // Two branches at one tip must not both go, each because the other holds it.
  private readonly branchDeletes = new SerialQueue();

  constructor(private readonly folder: string) {}

  async prepareWorktree(run: LocatedRun) {
    const { lease, repoPath, branch, baseSha, lastCheckpoint, rewind } = run;
    const folder = this.folderOf(lease.workflowRunId);
    await stopLeftoverGroups(this.groupsFileOf(lease.workflowRunId));
    await ensureFolder(this.folder);
    const repo = this.gitOf(lease.workflowRunId, repoPath);
    const tip = await requireValidBranch(repo, run);
    const realFolder = await findRealPath(folder);
    if (realFolder && (!tip || !(await isRunWorktree(repo, realFolder, branch)))) {
      throw new Error(
        `${folder} is not a worktree of ${repoPath} on ${branch}. Delete the folder.`,
      );
    }
    if (!realFolder) await repo.pruneWorktrees();
    const git = this.gitOf(lease.workflowRunId, folder);
    if (!tip) {
      await repo.addWorktreeWithNewBranch(folder, branch, baseSha);
      return { folder, isBranchCreated: true, lockFiles: await findLockFiles(git, branch) };
    }
    if (!realFolder) await repo.addWorktree(folder, branch);
    // A new worktree has the tip, so it needs the rewind again.
    if (rewind && (rewind.isFresh || !realFolder)) {
      const committer = this.gitOf(lease.workflowRunId, folder, halinkaIdentity);
      const supersededRef = this.supersededRefOf(run, rewind);
      const kept = await tipWithChanges(committer, run, { tip, rewind, supersededRef });
      await rewindBranch(git, run, { tip: kept, rewind, supersededRef });
    }
    await git.restoreBranch(branch, lastCheckpoint);
    return { folder, isBranchCreated: false, lockFiles: await findLockFiles(git, branch) };
  }

  // Host git never runs in an existing clone: the container can change its config.
  async prepareClone(run: LocatedRun, beforeNewClone = async () => {}) {
    const { lease, repoPath, branch, baseSha } = run;
    const folder = this.folderOf(lease.workflowRunId);
    await stopLeftoverGroups(this.groupsFileOf(lease.workflowRunId));
    await ensureFolder(this.folder);
    const repo = this.gitOf(lease.workflowRunId, repoPath);
    await requireNotCheckedOut(repo, run);
    const tip = await requireValidBranch(repo, run);
    const hasFolder = await pathExists(folder);
    if (hasFolder && (!tip || !(await hasGitFolder(folder)))) {
      throw new Error(`${folder} is not a clone of ${repoPath} on ${branch}. Delete the folder.`);
    }
    if (!tip) await repo.createBranch(branch, baseSha);
    if (!hasFolder) {
      await beforeNewClone();
      await rm(this.setUpMarkOf(lease.workflowRunId), { force: true });
      await writeFile(this.baseFilesMarkOf(lease.workflowRunId), "");
      await repo.cloneBranch(repoPath, folder, branch);
      const clone = this.cloneGitOf(lease.workflowRunId, folder);
      await clone.deleteRemote("origin");
      // `up` and `setup.run` must not run the agent's files.
      await clone.run("checkout", "--quiet", "--force", "--detach", baseSha);
      // The clone is new, so its config is the runner's.
      await copyFile(join(folder, ".git", "config"), this.gitConfigOf(lease.workflowRunId));
    }
    return { folder, isBranchCreated: !tip };
  }

  async isOnBaseFiles({ baseSha }: LocatedRun, sandbox: Sandbox) {
    return (await sandboxGit(sandbox).findCommit("HEAD")) === baseSha;
  }

  async restoreClone(run: LocatedRun, sandbox: Sandbox) {
    const { lease, repoPath, branch, baseSha, lastCheckpoint, rewind } = run;
    const baseFilesMark = this.baseFilesMarkOf(lease.workflowRunId);
    // A host mark, so a crash before the end of the restore cannot lose it.
    const isFresh = await pathExists(baseFilesMark);
    const git = sandboxGit(sandbox);
    const folder = this.folderOf(lease.workflowRunId);
    if ((await git.findGitFolder()) !== `${sandbox.workspaceFolder}/.git`) {
      throw new Error(`${folder} is not a clone of ${repoPath}. Delete the folder.`);
    }
    const tip = await git.findBranch(branch);
    if (!tip) throw new Error(`The branch ${branch} is missing in ${folder}. Delete the folder.`);
    if (!isCommitId(tip)) throw new Error(`"${tip}" from the sandbox is not a commit id`);
    if (!(await git.findCommit(lastCheckpoint))) {
      throw new Error(
        `The last checkpoint ${lastCheckpoint} is missing in ${folder}. Delete the folder.`,
      );
    }
    // Before the rewind, which would commit the base files as a reversal.
    if (isFresh && tip !== baseSha) await git.run("checkout", "--quiet", "--force", branch);
    const repo = this.gitOf(lease.workflowRunId, repoPath);
    if (rewind && (rewind.isFresh || isFresh)) {
      if (!(await repo.findCommit(tip))) {
        await this.fetchFromClone(repo, run, { sandbox, commit: tip, exclude: lastCheckpoint });
      }
      const supersededRef = this.supersededRefOf(run, rewind);
      await repo.createRef(supersededRef, tip);
      // The uncommitted files stay in the clone: they had no lent-value scan.
      const committer = sandboxGit(sandbox, halinkaIdentity);
      const kept = await tipWithChanges(committer, run, { tip, rewind, supersededRef });
      await rewindBranch(git, run, { tip: kept, rewind, supersededRef });
    }
    await git.restoreBranch(branch, lastCheckpoint);
    await rm(baseFilesMark, { force: true });
    // A later checkpoint must descend from the last stored one, or `publish` refuses it.
    const sourceTip = await repo.findBranch(branch);
    if (!sourceTip) throw new Error(`The branch ${branch} is missing in ${repoPath}`);
    if (sourceTip === lastCheckpoint) return;
    const workflowRunIds = await repo.listTrailers(lastCheckpoint, sourceTip, "Halinka-Run");
    if (workflowRunIds.some((workflowRunId) => workflowRunId !== String(lease.workflowRunId))) {
      throw new Error(
        `The branch ${branch} of ${repoPath} has commits after the last checkpoint that the run did not make. Move them to another branch, then reset ${branch} to ${shortSha(lastCheckpoint)}.`,
      );
    }
    await repo.moveBranch(branch, lastCheckpoint, sourceTip);
  }

  // Never moves the branch over a commit of the user.
  async publish(run: LocatedRun, sandbox: Sandbox, commit: string) {
    const { lease, repoPath, branch } = run;
    if (!isCommitId(commit)) throw new Error(`"${commit}" from the sandbox is not a commit id`);
    const repo = this.gitOf(lease.workflowRunId, repoPath);
    await requireNotCheckedOut(repo, run);
    const tip = await repo.findBranch(branch);
    if (tip === commit) return;
    const movedAway = () =>
      new Error(
        `Halinka cannot publish the checkpoint ${shortSha(commit)}: the branch ${branch} of ${repoPath} moved away from the run`,
      );
    if (!tip) throw movedAway();
    if (!(await repo.findCommit(commit))) {
      // The bundle excludes `tip`; a commit of the user is not in the clone.
      if (!(await sandboxGit(sandbox).findCommit(tip))) throw movedAway();
      await this.fetchFromClone(repo, run, { sandbox, commit, exclude: tip });
    }
    if (!(await repo.isAncestor(tip, commit))) throw movedAway();
    await repo.moveBranch(branch, commit, tip);
  }

  // A worktree has no process, so it is never `running`.
  async apply({
    workflowRunId,
    repoPath,
    spec,
    runBranch,
  }: Located<SandboxTarget>): Promise<SandboxState> {
    const folder = this.folderOf(workflowRunId);
    await stopLeftoverGroups(this.groupsFileOf(workflowRunId));
    if (spec !== "destroyed") return (await pathExists(folder)) ? "stopped" : "absent";
    if (!(await pathExists(repoPath))) {
      await rm(folder, { recursive: true, force: true });
      return "absent";
    }
    await ensureFolder(this.folder);
    const repo = this.gitOf(workflowRunId, repoPath);
    if (await pathExists(folder)) await repo.deleteWorktree(folder);
    await this.deleteRunRefs(repo, workflowRunId, runBranch);
    await rm(this.groupsFileOf(workflowRunId), { force: true });
    return "absent";
  }

  isSetUp(workflowRunId: number) {
    return pathExists(this.setUpMarkOf(workflowRunId));
  }

  async markSetUp(workflowRunId: number) {
    await writeFile(this.setUpMarkOf(workflowRunId), "");
  }

  async readGitConfig(workflowRunId: number) {
    const file = this.gitConfigOf(workflowRunId);
    const config = await readTextFile(file);
    if (config === undefined) {
      throw new Error(`${file} is missing. Delete the folder ${this.folderOf(workflowRunId)}.`);
    }
    return config;
  }

  async deleteClone(workflowRunId: number, repoPath: string, runBranch?: RunBranch) {
    await stopLeftoverGroups(this.groupsFileOf(workflowRunId));
    await rm(this.folderOf(workflowRunId), { recursive: true, force: true });
    await rm(this.gitConfigOf(workflowRunId), { force: true });
    await rm(this.setUpMarkOf(workflowRunId), { force: true });
    await rm(this.baseFilesMarkOf(workflowRunId), { force: true });
    if (!(await pathExists(repoPath))) return;
    await ensureFolder(this.folder);
    await this.deleteRunRefs(this.gitOf(workflowRunId, repoPath), workflowRunId, runBranch);
    await rm(this.groupsFileOf(workflowRunId), { force: true });
  }

  private async fetchFromClone(
    repo: Git,
    run: LocatedRun,
    { sandbox, commit, exclude }: FetchFromCloneOptions,
  ) {
    const file = `${this.folderOf(run.lease.workflowRunId)}.bundle`;
    try {
      await writeBundle(sandbox, file, { commit, exclude });
      await requirePlainBundle(file);
      await repo.fetchCommit(file, commit);
    } finally {
      await rm(file, { force: true });
    }
  }

  // The runner names `folder` after the server, and two servers can use one checkout.
  private supersededRefs(workflowRunId: number) {
    return `refs/halinka/superseded/${basename(this.folder)}/${workflowRunId}/`;
  }

  private supersededRefOf({ lease }: LocatedRun, { stepRunId }: Rewind) {
    return `${this.supersededRefs(lease.workflowRunId)}${stepRunId}`;
  }

  private async deleteRunRefs(repo: Git, workflowRunId: number, runBranch?: RunBranch) {
    await repo.pruneWorktrees();
    await repo.deleteRefs(this.supersededRefs(workflowRunId));
    await this.branchDeletes.run(() => deleteRunBranch(repo, runBranch));
  }

  // The groups file lets the next claim stop git that a crashed runner left.
  private gitOf(workflowRunId: number, cwd: string, config?: Record<string, string>) {
    return new Git(new HostSandbox(cwd, this.groupsFileOf(workflowRunId)), config);
  }

  private cloneGitOf(workflowRunId: number, folder: string) {
    const sandbox = new HostSandbox(folder, this.groupsFileOf(workflowRunId));
    return new Git(sandbox, undefined, { env: noHostConfig });
  }

  folderOf(workflowRunId: number) {
    return join(this.folder, runFolderName(workflowRunId));
  }

  groupsFileOf(workflowRunId: number) {
    return `${this.folderOf(workflowRunId)}.groups`;
  }

  private setUpMarkOf(workflowRunId: number) {
    return `${this.folderOf(workflowRunId)}.set-up`;
  }

  private baseFilesMarkOf(workflowRunId: number) {
    return `${this.folderOf(workflowRunId)}.base-files`;
  }

  private gitConfigOf(workflowRunId: number) {
    return `${this.folderOf(workflowRunId)}.git-config`;
  }
}
