import type { ShellStep } from "@halinka/workflow";

import type { LoopBudget } from "./limits";
import { OutputTail } from "./outputTail";
import {
  type AttemptBodyResult,
  commitAttempt,
  runAttempts,
  singleAttempt,
  startingPoint,
  type StepRun,
} from "./runAttempts";
import type { StepContext } from "./runDeps";
import { runScript } from "./runScript";
import { stepTimeLimit, withinTimeLimit } from "./timeLimit";

const maxShellSummaryLines = 10;
const maxSummaryLength = 4000;

export const executeShellStep = (
  context: StepContext,
  { step, stepRun, loop }: { step: ShellStep; stepRun: StepRun; loop?: LoopBudget },
) =>
  runAttempts(
    context,
    { stepId: step.id, stepRun, policy: singleAttempt },
    async ({ attemptId, attempt }, signal) => {
      // A shell step has one attempt, so a later attempt follows an interrupted one.
      const before = await startingPoint(context, {
        stepId: step.id,
        attempt,
        isInterrupted: attempt > 1,
        isWritable: true,
      });
      const tail = new OutputTail(maxShellSummaryLines, maxSummaryLength);
      const started = Date.now();
      const usage = () => ({ activeMs: Date.now() - started });
      const result = await withinTimeLimit<AttemptBodyResult>(
        stepTimeLimit(step.timeout, loop),
        {
          action: async (within) => {
            const of = { stepId: step.id, attemptId };
            const exitCode = await runScript(context, { script: step, of, tail }, within);
            const status = exitCode === 0 ? "succeeded" : "failed";
            return { status, exitCode, summary: tail.text(), usage: usage() };
          },
          atLimit: ({ message }) => {
            const summary = [tail.text(), message].filter(Boolean).join("\n\n");
            return { status: "failed", summary, usage: usage() };
          },
        },
        signal,
      );
      if (signal.aborted) return result;
      const checkpoint = await commitAttempt(context, {
        stepId: step.id,
        attemptId,
        attempt,
        before,
      });
      return { ...result, checkpoint };
    },
  );
