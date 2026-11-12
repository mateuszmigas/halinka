import { executeRun, type RepoSource, type RunDeps, type RunInbox } from "@halinka/engine";
import type {
  ClaimedAgentTest,
  ClaimedRun,
  ControlPlane,
  RepoPlace,
  SandboxKind,
} from "@halinka/protocol";
import { hostGit, stopLeftoverGroups } from "@halinka/sandbox/host";
import type { FileLocks } from "@halinka/utils/fileLocks";

import type { BranchPusher } from "./branchPusher";
import type { GitHubMirrors } from "./githubMirrors";
import type { LentValues } from "./lentValues";
import { madeUpComment, runComment } from "./runComment";
import { madeUpPullRequest, runPullRequest } from "./runPullRequest";
import { type Located, type Workspaces, runFolderName } from "./workspaces";

export type RunSandbox = Pick<RunDeps, "sandbox" | "agents"> & Pick<RepoSource, "publish">;

// One implementation per sandbox kind.
export type SandboxRuns = {
  prepare: (
    run: Located<ClaimedRun>,
    plane: ControlPlane,
    signal: AbortSignal,
  ) => Promise<RunSandbox>;
  // After the run, before the release of its workspace lock.
  endRun: (workflowRunId: number) => void;
  test: (test: ClaimedAgentTest, signal: AbortSignal) => Promise<Record<string, unknown>>;
  // What a crash of an earlier process left, or what a test left after its end.
  deleteTest: () => Promise<void>;
};

type RunExecutorDeps = {
  sandboxKind: SandboxKind;
  runs: Pick<SandboxRuns, "prepare" | "endRun">;
  planeOf: (signal: AbortSignal) => ControlPlane;
  lent: LentValues;
  locks: Pick<FileLocks, "take">;
  workspaces: Pick<Workspaces, "groupsFileOf">;
  mirrors: Pick<GitHubMirrors, "ensureCommits">;
  pusher: BranchPusher;
  requirePlaceInRoots: (place: RepoPlace) => Promise<void>;
};

const kindMismatch = ({ lease, sandboxKind }: ClaimedRun, runnerKind: SandboxKind) =>
  new Error(
    `Run ${lease.workflowRunId} has a ${sandboxKind} workspace, and this runner runs in a ${runnerKind}. ` +
      `Remove the workspace of the run, or start the runner with --runs-in ${sandboxKind}.`,
  );

export class RunExecutor {
  constructor(private readonly deps: RunExecutorDeps) {}

  // `executeRun` returns after its processes ended, so the lock covers them.
  async execute(run: ClaimedRun, inbox: RunInbox, signal: AbortSignal) {
    const { sandboxKind, runs, planeOf, lent, locks, workspaces, pusher } = this.deps;
    const { workflowRunId } = run.lease;
    const release = await locks
      .take(runFolderName(workflowRunId), signal, (pid) =>
        console.log(
          `Run ${workflowRunId} waits for the runner process ${pid}, which holds its workspace`,
        ),
      )
      .catch((error: unknown) => {
        if (signal.aborted) return undefined;
        throw error;
      });
    if (!release) return "aborted";
    try {
      if (signal.aborted) return "aborted";
      if (run.sandboxKind !== sandboxKind) throw kindMismatch(run, sandboxKind);
      const plane = planeOf(signal);
      const located = await this.locate(run, plane, signal);
      const { publish, ...runSandbox } = await runs.prepare(located, plane, signal);
      const openPullRequest = run.isTestRun
        ? madeUpPullRequest
        : runPullRequest(pusher, plane, run);
      const commentOnPullRequest = run.isTestRun ? madeUpComment : runComment(pusher, plane, run);
      const repoSource = { publish, openPullRequest, commentOnPullRequest };
      return await executeRun(
        {
          plane,
          ...runSandbox,
          repoSource,
          inbox,
          lent,
          ...(located.reviewBase && { reviewBase: located.reviewBase }),
        },
        run,
        signal,
      );
    } finally {
      runs.endRun(workflowRunId);
      // After the run, the system can give the pids of the groups file to other processes.
      try {
        await stopLeftoverGroups(workspaces.groupsFileOf(workflowRunId));
      } finally {
        await release();
      }
    }
  }

  private async locate(
    run: ClaimedRun,
    plane: ControlPlane,
    signal: AbortSignal,
  ): Promise<Located<ClaimedRun> & { reviewBase?: string }> {
    const { mirrors, workspaces, requirePlaceInRoots } = this.deps;
    await requirePlaceInRoots(run);
    if (run.repoPath !== undefined) return { ...run, isMirror: false };
    const repoPath = await mirrors.ensureCommits({
      githubRepoId: run.githubRepoId,
      commits: [run.definitionSha, run.baseSha],
      groupsFile: workspaces.groupsFileOf(run.lease.workflowRunId),
      readAccess: () => plane.readMirrorAccess(run.lease),
      signal,
    });
    if (run.pullRequestNumber === undefined) return { ...run, repoPath, isMirror: true };
    // A pull request with an unrelated history has no base: the run goes on with no note.
    const reviewBase = await hostGit(repoPath, undefined, { signal })
      .readMergeBase(run.baseSha, run.definitionSha)
      .catch(() => undefined);
    return { ...run, repoPath, isMirror: true, ...(reviewBase && { reviewBase }) };
  }
}
