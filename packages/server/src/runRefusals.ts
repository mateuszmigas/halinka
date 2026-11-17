import { isEndedOrExpired, isRunResult } from "@halinka/protocol";
import { schemaVersion } from "@halinka/workflow";

import type { DbWorkflowRun } from "./db/schema";
import { noRun, ServiceError } from "./services/serviceError";

export const isOlderSchema = (run: { schemaVersion: number }) => run.schemaVersion < schemaVersion;

export const olderSchemaReason = (workflowRunId: number) =>
  `Run ${workflowRunId} is from an older Halinka. Migrate the workflow and start a new run.`;

export const testRunReason = (workflowRunId: number) =>
  `Run ${workflowRunId} is a test run: it writes nothing to GitHub`;

type IsFinished = (status: string) => boolean;

export const finishedRunRefusal = (
  { id, status, deletingAt }: DbWorkflowRun,
  isFinished: IsFinished = isRunResult,
) => {
  if (deletingAt) return noRun(id);
  if (!isFinished(status)) {
    return new ServiceError("CONFLICT", `Run ${id} is active. Cancel it first.`);
  }
  return undefined;
};

// "Push branch": an ended or expired run that is not a test.
export const pushRefusal = (run: DbWorkflowRun) => {
  const refusal = finishedRunRefusal(run, isEndedOrExpired);
  if (refusal) return refusal;
  if (run.testRun) return new ServiceError("CONFLICT", testRunReason(run.id));
  return undefined;
};

export const pullRequestRefusal = (run: DbWorkflowRun) => {
  const refusal = pushRefusal(run);
  if (refusal) return refusal;
  if (run.pullRequestNumber !== null) {
    return new ServiceError("CONFLICT", `Run ${run.id} started on a pull request`);
  }
  if (run.status !== "succeeded") {
    return new ServiceError(
      "CONFLICT",
      `Run ${run.id} did not succeed, so it opens no pull request`,
    );
  }
  return undefined;
};
