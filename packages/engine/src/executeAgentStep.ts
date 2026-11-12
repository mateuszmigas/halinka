import { errorMessage } from "@halinka/utils/errors";
import { type AgentStep, canWrite, outcomeResult, type StepReport } from "@halinka/workflow";

import { unchangedCheckpoint } from "./checkpoints";
import { isStepLimit, type LoopBudget, type RunBudget } from "./limits";
import { basePrompt, toldPrompt } from "./prompts";
import {
  type AttemptBodyResult,
  commitAttempt,
  runAttempts,
  startingPoint,
  type StepRun,
} from "./runAttempts";
import type { StepContext } from "./runDeps";
import { runGates } from "./runGates";
import { StepSession, type TurnsResult } from "./stepSession";

type AgentStepRun = {
  step: AgentStep;
  stepRun: StepRun;
  loop?: LoopBudget;
  runBudget?: RunBudget;
};

const defaultMaxAttempts = 3;
const defaultOnExhausted = "ask_human";

const limitMessage = (label: string) =>
  `The agent reached ${label}. "Continue" adds the same amount to that limit.`;

const readOnlyChanged = (files: string[]) =>
  `The step is read-only, but the agent changed these files: ${files.join(", ")}. ` +
  "Halinka discarded the changes.";

const reportResult = (step: AgentStep, report: StepReport): AttemptBodyResult => ({
  status: outcomeResult(step.outcomes, report.outcome) === "fail" ? "failed" : "succeeded",
  ...report,
});

export const executeAgentStep = async (
  context: StepContext,
  { step, stepRun, loop, runBudget }: AgentStepRun,
) => {
  const { checkpoints, deps, asData } = context;
  const isWritable = canWrite(step);
  const isChangeRequired = isWritable && (step.require_changes ?? true);
  const { stepRunId, reopened, sessionId, sessionCostUsd, told, usage } = stepRun;
  const session = new StepSession(context, step, {
    stepRunId,
    agent: deps.agents.get(step.agent),
    loop,
    runBudget,
    used: usage,
    basePrompt: (prompt) =>
      basePrompt(step, { reopened, reviewBase: deps.reviewBase, asData }, prompt),
    // The own session first: after a crash in a reopen, it is newer than the reopened one.
    earlier: sessionId === undefined ? reopened : { sessionId, sessionCostUsd },
    told: told?.map(toldPrompt),
  });
  let stepStart: string | undefined;
  const policy = {
    maxAttempts: step.max_attempts ?? defaultMaxAttempts,
    onExhausted: step.on_exhausted ?? defaultOnExhausted,
  };
  try {
    return await runAttempts(
      context,
      { stepId: step.id, stepRun, policy },
      async ({ attemptId, attempt }, signal, retry) => {
        if (retry?.raise) session.limits.raise(retry.raise);
        const before = await startingPoint(context, {
          stepId: step.id,
          attempt,
          isInterrupted: attempt > 1 && !retry,
          isReopenStart: reopened !== undefined && attempt === 1,
          isWritable,
        });
        stepStart ??= before;
        session.startAttempt();
        let turns: TurnsResult;
        try {
          turns = await session.withWorkspace(() =>
            session.runTurns(
              { attemptId, retryText: retry?.prompt, isInterrupted: attempt > 1 },
              signal,
            ),
          );
        } catch (error) {
          return { status: "failed", error: errorMessage(error), ...session.attemptFacts() };
        }
        const limit = "limit" in turns ? turns.limit : undefined;
        // A person can raise only a step limit.
        const stepLimit = limit && isStepLimit(limit) ? limit : undefined;
        const result: AttemptBodyResult = {
          ...("error" in turns
            ? { status: "failed", error: turns.error }
            : "limit" in turns
              ? {
                  status: stepLimit ? "stopped" : "failed",
                  summary: `The agent reached ${session.limits.label(turns.limit)}.`,
                }
              : reportResult(step, turns)),
          ...session.attemptFacts(),
        };
        if (signal.aborted) return result;
        const checkpoint = isWritable
          ? await commitAttempt(context, {
              stepId: step.id,
              attemptId,
              attempt,
              before,
              summary: result.summary,
            })
          : unchangedCheckpoint(before);
        const failed = (problem: string): AttemptBodyResult => ({
          ...result,
          status: "failed",
          summary: [result.summary ?? result.error, problem].filter(Boolean).join("\n\n"),
          checkpoint,
        });
        if (!isWritable) {
          const changed = await checkpoints.discard(before);
          if (changed.length > 0) return failed(readOnlyChanged(changed));
        }
        if (result.status === "failed") return { ...result, checkpoint };
        if (stepLimit) {
          const limitStop = {
            message: limitMessage(session.limits.label(stepLimit)),
            limit: stepLimit,
          };
          return { ...result, checkpoint, limitStop };
        }
        // A retry after a failed gate has nothing to change when the step already holds the work.
        const isUnchanged = checkpoint.after === stepStart && !stepRun.changedFiles?.length;
        let gates;
        try {
          gates = await runGates(
            context,
            { step, attemptId, isUnchanged: isChangeRequired && isUnchanged },
            signal,
          );
        } catch (error) {
          return failed(errorMessage(error));
        }
        if (!gates) return { ...result, checkpoint };
        return { ...failed(gates.failures), gateFailure: gates.gateFailure };
      },
    );
  } finally {
    await session.close();
  }
};
