export const notStartedStepsOf = <T extends { id: string }>(
  steps: T[],
  stepRuns: { stepId: string }[],
) => steps.filter(({ id }) => !stepRuns.some(({ stepId }) => stepId === id));
