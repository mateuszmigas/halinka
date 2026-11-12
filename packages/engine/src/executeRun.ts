import type { ClaimedRun } from "@halinka/protocol";
import { dataBlock } from "@halinka/workflow";

import { Checkpoints } from "./checkpoints";
import { EventLog } from "./eventLog";
import { executeAgentStep } from "./executeAgentStep";
import { executeApprovalStep } from "./executeApprovalStep";
import { executeGitHubStep } from "./executeGitHubStep";
import { executeShellStep } from "./executeShellStep";
import { type NextAction, nextAction } from "./nextAction";
import type { StepOutcome, StepRun } from "./runAttempts";
import type { RunDeps, StepContext } from "./runDeps";

export type EngineResult = "succeeded" | "failed" | "aborted";

const abortFlushTimeoutMs = 2000;

const executeStep = (
  context: StepContext,
  { step, loop, reviews, runBudget }: Extract<NextAction, { kind: "run" }>,
  stepRun: StepRun,
): Promise<StepOutcome | "aborted"> => {
  switch (step.type) {
    case "shell":
      return executeShellStep(context, { step, stepRun, loop });
    case "agent":
      return executeAgentStep(context, { step, stepRun, loop, runBudget });
    case "approval":
      return executeApprovalStep(context, { step, stepRun, reviews });
    case "github":
      return executeGitHubStep(context, { step, stepRun, loop });
  }
};

// On abort, the step run stays running so a later attempt continues it.
export const executeRun = async (
  deps: RunDeps,
  {
    lease,
    branch,
    workflow,
    inputs,
    isUntrusted,
    steps,
    isWorkspaceOpened = false,
    agentModels,
  }: ClaimedRun,
  signal: AbortSignal,
): Promise<EngineResult> => {
  const events = new EventLog(deps.plane, lease);
  const checkpoints = new Checkpoints({
    sandbox: deps.sandbox,
    lent: deps.lent,
    workflowRunId: lease.workflowRunId,
    branch,
    signal,
  });
  const recorded = [...steps];
  const asData = isUntrusted ? dataBlock : (text: string) => text;
  const context: StepContext = {
    deps,
    lease,
    checkpoints,
    events,
    signal,
    isWorkspaceOpened,
    agentModels,
    asData,
    workflowName: workflow.name,
  };
  const aborted = async () => {
    const isSettled = await events
      .flushBefore(AbortSignal.timeout(abortFlushTimeoutMs))
      .catch(() => true);
    if (!isSettled) {
      console.error(`Run ${lease.workflowRunId}: the last events were not stored in time`);
    }
    return "aborted" as const;
  };
  try {
    for (;;) {
      if (signal.aborted) return await aborted();
      const action = nextAction(workflow, recorded, { inputs, isUntrusted });
      if (action.kind === "finish") {
        return (await events.flushBefore(signal)) ? action.result : await aborted();
      }
      const stepId = action.step.id;
      if (action.kind === "start") {
        const stepRunId = await deps.plane.startStep(lease, stepId);
        recorded.push({ stepRunId, stepId, status: "running", failedAttempts: 0 });
        continue;
      }
      const { loop } = action;
      const parent = loop && { stepRunId: loop.stepRunId, iteration: loop.iteration };
      const stepRun: StepRun = action.stepRun ?? {
        stepRunId: await deps.plane.startStep(lease, stepId, parent),
        failedAttempts: 0,
      };
      const { stepRunId, failedAttempts } = stepRun;
      const result =
        action.kind === "end"
          ? { ...action.result, ...(await deps.plane.finishStep(lease, stepRunId, action.result)) }
          : await executeStep(context, action, stepRun);
      if (result === "aborted") return await aborted();
      const finished = {
        stepRunId,
        stepId,
        failedAttempts,
        ...(parent && { parent }),
        ...deps.lent.mask(result),
      };
      const index = recorded.findIndex((recordedStep) => recordedStep.stepRunId === stepRunId);
      if (index === -1) recorded.push(finished);
      else recorded[index] = finished;
    }
  } finally {
    events.abandon();
  }
};
