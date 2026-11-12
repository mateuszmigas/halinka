import type { StepRunStatus } from "@halinka/server/client";

type Iteration = { iteration: number; stepRuns: { id: number; status: StepRunStatus }[] };

export const shownIterationOf = (
  iterations: Iteration[],
  selectedId: number | undefined,
  chosen: number | undefined,
) =>
  chosen ??
  iterations.find(({ stepRuns }) => stepRuns.some(({ id }) => id === selectedId))?.iteration ??
  iterations.findLast(({ stepRuns }) => stepRuns.some(({ status }) => status !== "superseded"))
    ?.iteration ??
  iterations.at(-1)?.iteration;
