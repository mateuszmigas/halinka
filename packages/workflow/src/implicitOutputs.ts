import type { z } from "zod";

import { type Agents, reportsNoCost } from "./agents";
import { leafSteps } from "./leafSteps";
import { canWrite } from "./permissions";
import type { OutputFields } from "./stepReport";
import type { AgentStep, Workflow } from "./workflow";

const implicitOutputs = {
  changed_files: { type: "array", items: "string" },
  changed_file_count: "number",
  commit: "string",
  session_id: "string",
} as const satisfies OutputFields;

const costOutputs = { cost_usd: "number" } as const satisfies OutputFields;

const readOnlyOutputs = { reviewed_commit: "string" } as const satisfies OutputFields;

const reservedOutputs = { ...implicitOutputs, ...costOutputs, ...readOnlyOutputs };

type ImplicitValues = Partial<Record<keyof typeof reservedOutputs, unknown>>;

export const agentOutputs = (step: AgentStep, agents: Agents = {}): OutputFields => ({
  ...step.outputs,
  ...implicitOutputs,
  ...(!reportsNoCost(agents, step.agent) && costOutputs),
  ...(!canWrite(step) && readOnlyOutputs),
});

type AttemptValues = {
  commit?: string;
  sessionId?: string;
  changedFiles?: string[];
  changedFileCount?: number;
  costUsd?: number;
};

const implicitOutputValues = (
  step: AgentStep,
  { commit, sessionId, changedFiles = [], changedFileCount, costUsd }: AttemptValues,
): ImplicitValues | undefined => {
  if (commit === undefined) return undefined;
  return {
    changed_files: changedFiles,
    changed_file_count: changedFileCount ?? changedFiles.length,
    commit,
    ...(sessionId !== undefined && { session_id: sessionId }),
    ...(costUsd !== undefined && { cost_usd: costUsd }),
    ...(!canWrite(step) && { reviewed_commit: commit }),
  };
};

type RecordedValues = Omit<AttemptValues, "costUsd"> & {
  stepId: string;
  outputs?: Record<string, unknown> | null;
  usage?: { costUsd?: number };
};

export const withImplicitOutputs = <T extends RecordedValues>(
  workflow: Workflow,
  recorded: T[],
) => {
  const agentSteps = new Map(
    leafSteps(workflow).flatMap((step) =>
      step.type === "agent" ? [[step.id, step] as const] : [],
    ),
  );
  return recorded.map((stepRun) => {
    const step = agentSteps.get(stepRun.stepId);
    const implicit =
      step && implicitOutputValues(step, { ...stepRun, costUsd: stepRun.usage?.costUsd });
    return implicit ? { ...stepRun, outputs: { ...stepRun.outputs, ...implicit } } : stepRun;
  });
};

export const checkOutputNames = (outputs: OutputFields | null, context: z.RefinementCtx) => {
  for (const name of Object.keys(outputs ?? {})) {
    if (!Object.hasOwn(reservedOutputs, name)) continue;
    context.addIssue({
      code: "custom",
      path: [name],
      message: `Use another name: Halinka gives the output "${name}"`,
    });
  }
};
