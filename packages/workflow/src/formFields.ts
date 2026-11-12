import type { Step } from "./workflow";
import { alternatives, workflowJsonSchema } from "./workflowJsonSchema";

const shownFields = {
  shell: ["id", "run", "if", "timeout"],
  agent: [
    "id",
    "agent",
    "model",
    "prompt",
    "if",
    "timeout",
    "max_attempts",
    "on_exhausted",
    "max_turns",
    "max_cost_usd",
    "max_reminders",
  ],
  approval: ["id", "message", "if"],
  github: ["id", "action", "title", "body", "closes", "if", "timeout"],
  loop: ["id", "until", "max_iterations", "if", "timeout", "max_cost_usd"],
} as const satisfies Record<Step["type"], readonly string[]>;

export type StepField = (typeof shownFields)[Step["type"]][number];

export type FormField = {
  name: StepField;
  isOptional: boolean;
  isNumeric: boolean;
  options?: readonly string[];
};

export const stepFieldNames = [...new Set(Object.values(shownFields).flat())];

export const formFieldsOf = (type: string): FormField[] | undefined => {
  if (!Object.hasOwn(shownFields, type)) return undefined;
  const steps = workflowJsonSchema().properties?.steps?.items;
  const schema = steps && alternatives(steps).find((step) => step.properties?.type?.const === type);
  return shownFields[type as Step["type"]].map((name) => {
    const field = schema?.properties?.[name];
    return {
      name,
      isOptional: !schema?.required?.includes(name),
      isNumeric: field?.type === "number" || field?.type === "integer",
      options: field?.enum,
    };
  });
};
