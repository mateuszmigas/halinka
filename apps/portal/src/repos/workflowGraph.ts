import { parseStepFields, type StepFields } from "@halinka/workflow";

export type StepAddress = { index: number; parent?: number };
export type GraphStep = StepAddress & {
  key: string;
  id: string;
  step: StepFields;
};
export type WorkflowGraph = {
  source: string;
  entries: GraphStep[];
  nextKey: number;
  isReadable: boolean;
};

export const workflowGraph = (
  source: string,
  previous?: WorkflowGraph,
  identity?: StepAddress & { key: string },
): WorkflowGraph => {
  const steps = parseStepFields(source);
  if (!steps)
    return {
      source,
      entries: previous?.entries ?? [],
      nextKey: previous?.nextKey ?? 1,
      isReadable: false,
    };
  const all = steps.flatMap((step) => [step, ...(step.children ?? [])]);
  const counts = new Map<string, number>();
  for (const step of all) counts.set(step.id, (counts.get(step.id) ?? 0) + 1);
  const old = new Map<string, GraphStep[]>();
  for (const entry of previous?.entries ?? [])
    old.set(entry.id, [...(old.get(entry.id) ?? []), entry]);
  let nextKey = previous?.nextKey ?? 1;
  const entries: GraphStep[] = [];
  const add = (step: StepFields, index: number, parent?: number) => {
    const matches = old.get(step.id);
    const key =
      identity?.index === index && identity.parent === parent
        ? identity.key
        : step.id && counts.get(step.id) === 1 && matches?.length === 1
          ? matches[0]!.key
          : `step-${nextKey++}`;
    entries.push({ key, id: step.id, step, index, parent });
  };
  steps.forEach((step, index) => {
    add(step, index);
    step.children?.forEach((child, childIndex) => add(child, childIndex, index));
  });
  return { source, entries, nextKey, isReadable: true };
};
