import { type BranchPush, pullRequestText } from "@halinka/protocol";

import { type ConnectedRunners, requireRunner } from "../connectedRunners";
import type { Db } from "../db/client";
import { inTransaction, type Repositories, type RunWithRepo } from "../db/repositories";
import { repoPlaceOf } from "../db/schema";
import { findStaleReview, nothingToPushReason, storePush } from "../pushLease";
import { inRunTransaction, type RunBus } from "../runBus";
import { pullRequestRefusal, pushRefusal } from "../runRefusals";
import type { GitHubAction, GitHubAppService } from "./githubAppService";
import { noRun, ServiceError } from "./serviceError";

type RunnerOf = ReturnType<typeof requireRunner>;

type PushTarget = { run: RunWithRepo; runnerId: number; input: BranchPush };

type PushServiceOptions = {
  db: Db;
  bus: RunBus;
  gitHubApp: GitHubAppService;
  connectedRunners: ConnectedRunners;
};

// The checks of "Push branch" and "Open PR" under the run's row lock.
const lockTarget = async (
  { workflowRun, stepAttempt, pushedBranch }: Repositories,
  id: number,
): Promise<PushTarget> => {
  const run = await workflowRun.lockById(id);
  if (!run) throw noRun(id);
  const refusal = pushRefusal(run);
  if (refusal) throw refusal;
  const commit = (await stepAttempt.findLastCheckpoint(id)) ?? run.baseSha;
  const { repoId, branch, baseSha, runnerId } = run;
  if (commit === baseSha || runnerId === null) {
    throw new ServiceError("CONFLICT", nothingToPushReason(id));
  }
  const pushedCommit = (await pushedBranch.find(repoId, branch))?.commit;
  const input = {
    ...repoPlaceOf(run),
    workflowRunId: id,
    branch,
    baseSha,
    commit,
    pushedCommit,
    pullRequestNumber: run.pullRequestNumber ?? undefined,
  };
  return { run, runnerId, input };
};

// "Push branch" and "Open PR" of a finished run: the runner pushes, and the server stores the push.
export class PushService {
  constructor(private readonly options: PushServiceOptions) {}

  async push(id: number) {
    const target = await inTransaction(this.options.db, (repositories) =>
      lockTarget(repositories, id),
    );
    const github = await this.findRepoToken(target, "push");
    await this.callRunner(target.runnerId, (runner) =>
      runner.pushBranch({ ...target.input, github }),
    );
    await this.storeLease(target);
    return { pushedCommit: target.input.commit };
  }

  async openPullRequest(id: number) {
    const target = await inTransaction(this.options.db, async (repositories) => {
      const locked = await lockTarget(repositories, id);
      const refusal = pullRequestRefusal(locked.run);
      if (refusal) throw refusal;
      const stale = await findStaleReview(repositories, locked.run, locked.input.commit);
      if (stale) throw new ServiceError("CONFLICT", stale);
      return locked;
    });
    const github = await this.findRepoToken(target, "openPullRequest");
    const answer = await this.callRunner(target.runnerId, (runner) =>
      runner.openPullRequest({
        ...target.input,
        ...pullRequestText(id, target.run.workflowName),
        github,
      }),
    );
    // The portal shows the URL as a link.
    const url =
      "url" in answer && answer.url.startsWith("https://github.com/") ? answer.url : undefined;
    const outcome = url
      ? `The pull request is open: ${url}`
      : `The pull request failed: ${"error" in answer ? answer.error : "the runner gave a URL outside github.com"}`;
    await this.storeLease(target, url, outcome);
    if (!url) throw new ServiceError("CONFLICT", `The branch is on GitHub. ${outcome}`);
    return { pullRequestUrl: url };
  }

  private findRepoToken({ runnerId, run }: PushTarget, action: GitHubAction) {
    const { gitHubApp, connectedRunners } = this.options;
    // An offline runner must not cost a token.
    requireRunner(connectedRunners, runnerId);
    return gitHubApp.findPushToken(run, action);
  }

  // Do not hold the row lock across the runner call (up to 60 s).
  private callRunner<T>(runnerId: number, call: (runner: RunnerOf) => Promise<T>) {
    return call(requireRunner(this.options.connectedRunners, runnerId)).catch((error: unknown) => {
      if (!(error instanceof ServiceError) || error.code !== "RUNNER_OFFLINE") throw error;
      throw new ServiceError(
        "CONFLICT",
        "The runner lost the connection. The push or the pull request can be on GitHub: check there, or try again.",
      );
    });
  }

  private async storeLease({ run, input }: PushTarget, pullRequestUrl?: string, outcome?: string) {
    const { branch, commit, pushedCommit: expected } = input;
    const refusal = (message: string) =>
      new ServiceError("CONFLICT", outcome ? `${message} ${outcome}` : message);
    await inRunTransaction(this.options.db, this.options.bus, async (repositories, changed) => {
      const write = { commit, expected, pullRequestUrl };
      const problem = await storePush(repositories, { repoId: run.repoId, branch, write });
      if (problem) throw refusal(problem);
      changed(run.id, "state");
    });
  }
}
