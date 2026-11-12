import { leaseLost, maxRunErrorLength, type RunLease, type RunResult } from "@halinka/protocol";

import type { Repositories } from "./db/repositories";
import type { RunChange } from "./runBus";

export const closeEndedRun = async (
  { stepRun, stepAttempt, inboxItem, workflowRun }: Repositories,
  workflowRunId: number,
  result: RunResult,
) => {
  await stepAttempt.closeRunning(workflowRunId, result === "cancelled" ? "cancelled" : "lost");
  await stepRun.closeRunning(workflowRunId, result);
  await inboxItem.closePending(workflowRunId);
  await workflowRun.stopSandbox(workflowRunId);
};

type EndRunOptions = { result: RunResult; error?: string };

export const endRun = async (
  repositories: Repositories,
  { workflowRunId, lease }: RunLease,
  { result, error }: EndRunOptions,
) => {
  const stored = error ? error.slice(0, maxRunErrorLength) : undefined;
  if (
    !(await repositories.workflowRun.finish(workflowRunId, lease, {
      status: result,
      error: stored,
    }))
  ) {
    throw leaseLost(workflowRunId);
  }
  await closeEndedRun(repositories, workflowRunId, result);
};

// A question waits only while its attempt runs.
export const closeEndedQuestions = async (
  { inboxItem, workflowRun }: Repositories,
  workflowRunId: number,
) => {
  if (await inboxItem.closeQuestionsOfEndedAttempts(workflowRunId)) {
    await workflowRun.resume(workflowRunId);
  }
};

// Gives back a run its process no longer executes: cancelled on a cancel request, else queued again.
export const releaseRun = async (
  repositories: Repositories,
  run: { id: number; leaseToken: string; cancelRequestedAt: Date | null },
  changed: (workflowRunId: number, change: RunChange) => void,
) => {
  changed(run.id, "state");
  if (run.cancelRequestedAt) {
    const lease = { workflowRunId: run.id, lease: run.leaseToken };
    await endRun(repositories, lease, { result: "cancelled" });
    return;
  }
  await repositories.workflowRun.requeue(run.id, run.leaseToken);
  await repositories.stepAttempt.closeRunning(run.id, "lost");
  await closeEndedQuestions(repositories, run.id);
};
