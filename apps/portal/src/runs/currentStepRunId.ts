import type { StepRunStatus } from "@halinka/server/client";

type CurrentRun = {
  stepRuns: { id: number; status: StepRunStatus }[];
  messageTarget?: { stepRunId: number };
};

// Step runs come in id order: a child comes after its loop, so the deepest step wins.
export const currentStepRunIdOf = ({ stepRuns, messageTarget }: CurrentRun) =>
  messageTarget?.stepRunId ??
  stepRuns.findLast(({ status }) => status === "running")?.id ??
  stepRuns.findLast(({ status }) => status === "failed" || status === "cancelled")?.id ??
  stepRuns.findLast(({ status }) => status !== "superseded")?.id;
