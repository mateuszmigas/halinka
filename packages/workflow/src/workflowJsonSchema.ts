import { z } from "zod";

import { workflowSchema } from "./workflow";

export type JsonSchema = {
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  enum?: string[];
  const?: string;
  type?: string;
};

let schema: JsonSchema | undefined;

export const workflowJsonSchema = () =>
  (schema ??= z.toJSONSchema(workflowSchema, {
    io: "input",
    unrepresentable: "any",
  }) as JsonSchema);

export const alternatives = (schema: JsonSchema): JsonSchema[] => {
  const choices = schema.oneOf ?? schema.anyOf;
  return choices ? choices.flatMap(alternatives) : [schema];
};
