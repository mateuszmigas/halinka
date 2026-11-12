import {
  type RecordedStep,
  type Review,
  reviewsOf,
  type StepParent,
  type StepRunResult,
  type Usage,
} from "@halinka/protocol";
import { errorMessage } from "@halinka/utils/errors";
import {
  evaluateCondition,
  type ExpressionContext,
  type Inputs,
  interpolateStep,
  type LoopStep,
  passedStatuses,
  type LeafStep,
  type Workflow,
  type Step,
  withImplicitOutputs,
} from "@halinka/workflow";

import {
  addUsage,
  type LoopBudget,
  loopLimitLabel,
  loopLimitReached,
  type RunBudget,
  runBudgetOf,
  runLimitLabel,
  isRunLimitReached,
} from "./limits";

export type LoopScope = StepParent & LoopBudget;

// `start`: a loop's step run has no attempts
export type NextAction =
  | { kind: "start"; step: LoopStep }
  | {
      kind: "run";
      step: LeafStep;
      stepRun?: RecordedStep;
      loop?: LoopScope;
      reviews?: Review[];
      runBudget?: RunBudget;
    }
  | {
      kind: "end";
      step: Step;
      stepRun?: RecordedStep;
      loop?: LoopScope;
      result: StepRunResult;
    }
  | { kind: "finish"; result: "succeeded" | "failed" };

type Walked = NextAction | { kind: "complete" } | { kind: "failed"; stepId: string };

type WalkContext = ExpressionContext & { isUntrusted: boolean; runBudget?: RunBudget };
type WalkOptions = { recorded: RecordedStep[]; context: WalkContext; loop?: LoopScope };

const latestValuesOf = (stepRuns: RecordedStep[]): ExpressionContext["steps"] =>
  Object.fromEntries(
    stepRuns.map(({ stepId, status, summary, outcome, outputs }) => [
      stepId,
      { status, summary, outcome, outputs },
    ]),
  );

const stepAction = (
  step: Step,
  stepRun: RecordedStep | undefined,
  { recorded, context, loop }: WalkOptions,
): NextAction => {
  const end = (result: StepRunResult): NextAction => ({ kind: "end", step, stepRun, loop, result });
  try {
    if (step.if !== undefined && !evaluateCondition(step.if, context)) {
      return end({ status: "skipped" });
    }
    const { runBudget } = context;
    // `Limits` stops a started agent step.
    if (!stepRun && runBudget && isRunLimitReached(runBudget)) {
      const label = runLimitLabel(runBudget.maxUsd);
      return end({ status: "failed", summary: `The steps reached ${label}.` });
    }
    if (step.type === "loop") return { kind: "start", step };
    const reviews =
      step.type === "approval" && step.reviewers && reviewsOf(step.reviewers, recorded);
    return {
      kind: "run",
      step: interpolateStep(step, context, { isUntrusted: context.isUntrusted }),
      stepRun,
      loop,
      ...(reviews && { reviews }),
      ...(runBudget && { runBudget }),
    };
  } catch (error) {
    return end({ status: "failed", summary: errorMessage(error) });
  }
};

const loopAction = (
  step: LoopStep,
  loopRun: RecordedStep,
  { recorded, context: outerContext }: WalkOptions,
): NextAction => {
  const { stepRunId } = loopRun;
  const isInLoop = (stepRun: RecordedStep) => stepRun.parent?.stepRunId === stepRunId;
  const children = recorded.filter(isInLoop);
  const childIds = new Set(step.steps.map(({ id }) => id));
  const outside = Object.fromEntries(
    Object.entries(outerContext.steps).filter(([stepId]) => !childIds.has(stepId)),
  );
  const used = children.reduce<Usage | undefined>(
    (sum, { usage }) => addUsage(sum, usage),
    undefined,
  ) ?? { activeMs: 0 };
  const ofIteration = (iteration: number) =>
    children.filter(({ parent }) => parent?.iteration === iteration);
  const end = (result: StepRunResult): NextAction => ({
    kind: "end",
    step,
    stepRun: loopRun,
    result,
  });
  const first = Math.max(1, ...children.map(({ parent }) => parent?.iteration ?? 1));
  for (let iteration = first; ; iteration++) {
    const stepRuns = ofIteration(iteration);
    const previous = ofIteration(iteration - 1);
    const context: WalkContext = {
      ...outerContext,
      steps: { ...outside, ...latestValuesOf(stepRuns) },
      loop: { iteration, ...(previous.length > 0 && { previous: latestValuesOf(previous) }) },
    };
    const loop = { stepRunId, iteration, step, used };
    const walked = walk(step.steps, stepRuns, { recorded, context, loop });
    if (walked.kind === "failed") {
      return end({
        status: "failed",
        summary: `The step \`${walked.stepId}\` failed in iteration ${iteration}.`,
      });
    }
    // A started child checks the loop's limits in its attempt.
    if (walked.kind === "run" && !walked.stepRun) {
      const reached = loopLimitReached(loop);
      if (reached) {
        const label = loopLimitLabel(reached, step);
        return end({ status: "failed", summary: `The child steps reached ${label}.` });
      }
    }
    if (walked.kind !== "complete") return walked;
    try {
      if (evaluateCondition(step.until, context)) {
        const iterations = iteration === 1 ? "1 iteration" : `${iteration} iterations`;
        return end({ status: "succeeded", summary: `\`until\` held after ${iterations}.` });
      }
    } catch (error) {
      return end({ status: "failed", summary: errorMessage(error) });
    }
    if (iteration >= step.max_iterations) {
      return end({
        status: "failed",
        summary: `The loop reached max_iterations (${step.max_iterations}).`,
      });
    }
  }
};

const walk = (steps: readonly Step[], stepRuns: RecordedStep[], options: WalkOptions): Walked => {
  const latest = new Map(stepRuns.map((stepRun) => [stepRun.stepId, stepRun]));
  for (const step of steps) {
    const stepRun = latest.get(step.id);
    if (stepRun && stepRun.status !== "running") {
      if (!passedStatuses.includes(stepRun.status)) {
        return { kind: "failed", stepId: step.id };
      }
      continue;
    }
    if (step.type === "loop" && stepRun) return loopAction(step, stepRun, options);
    return stepAction(step, stepRun, options);
  }
  return { kind: "complete" };
};

// The children of a skipped loop have no step runs.
const skippedLoopChildren = (workflow: Workflow, topLevel: RecordedStep[]) => {
  const skipped = new Set(
    topLevel.filter(({ status }) => status === "skipped").map(({ stepId }) => stepId),
  );
  return Object.fromEntries(
    workflow.steps.flatMap((step) =>
      step.type === "loop" && skipped.has(step.id)
        ? step.steps.map(({ id }) => [id, { status: "skipped" }])
        : [],
    ),
  );
};

export type NextActionOptions = { inputs: Inputs; isUntrusted?: boolean };

export const nextAction = (
  workflow: Workflow,
  stepRuns: RecordedStep[],
  { inputs, isUntrusted = false }: NextActionOptions,
): NextAction => {
  const recorded = withImplicitOutputs(workflow, stepRuns);
  const topLevel = recorded.filter(({ parent }) => !parent);
  const runBudget = runBudgetOf(workflow, recorded);
  // `steps.x` of a loop child reads its last iteration
  const context = {
    isUntrusted,
    ...(runBudget && { runBudget }),
    inputs,
    steps: { ...skippedLoopChildren(workflow, topLevel), ...latestValuesOf(recorded) },
  };
  const walked = walk(workflow.steps, topLevel, { recorded, context });
  if (walked.kind === "complete") return { kind: "finish", result: "succeeded" };
  if (walked.kind === "failed") return { kind: "finish", result: "failed" };
  return walked;
};
