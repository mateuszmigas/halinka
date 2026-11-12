import type { LeafStep, Workflow } from "./workflow";

// The children of a loop take its place.
export const leafSteps = (workflow: Pick<Workflow, "steps">): LeafStep[] =>
  workflow.steps.flatMap((step) => (step.type === "loop" ? step.steps : [step]));

export const workflowAgents = (workflow: Workflow) =>
  [
    ...new Set(leafSteps(workflow).flatMap((step) => (step.type === "agent" ? [step.agent] : []))),
  ].sort();
