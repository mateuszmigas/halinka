type GroupedStepRun = { id: number; parentStepRunId?: number; iteration?: number };

export type StepRunGroup<T> = { stepRun: T; iterations: { iteration: number; stepRuns: T[] }[] };

// Step runs come in id order, so the iterations of a loop are in order too.
export const groupStepRuns = <T extends GroupedStepRun>(stepRuns: T[]): StepRunGroup<T>[] => {
  const children = Map.groupBy(stepRuns, ({ parentStepRunId }) => parentStepRunId);
  return (children.get(undefined) ?? []).map((stepRun) => ({
    stepRun,
    iterations: [
      ...Map.groupBy(children.get(stepRun.id) ?? [], ({ iteration }) => iteration ?? 0),
    ].map(([iteration, stepRuns]) => ({ iteration, stepRuns })),
  }));
};
