import type { Result } from "@halinka/utils/result";
import { z } from "zod";

import { identifierSchema } from "./identifier";
import type { ValueType } from "./stepReport";

type InputValue = string | number | boolean;

export type Inputs = Record<string, InputValue>;

const inputTypes = ["string", "number", "boolean"] as const satisfies ValueType[];

const typeHints: Record<ValueType, string> = {
  string: "Use text",
  number: "Use a number",
  boolean: "Use true or false",
};

const inputSchema = z
  .strictObject({
    type: z.enum(inputTypes).optional(),
    required: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    description: z.string().optional(),
  })
  .superRefine((input, context) => {
    const type = inputTypeOf(input);
    if (input.default === undefined) return;
    if (typeof input.default !== type) {
      context.addIssue({ code: "custom", path: ["default"], message: typeHints[type] });
    }
    if (input.required) {
      context.addIssue({
        code: "custom",
        path: ["required"],
        message: "Remove required or default",
      });
    }
  });

export type WorkflowInput = z.infer<typeof inputSchema>;

export const inputsSchema = z.record(identifierSchema, inputSchema);

export const inputTypeOf = ({ type = "string" }: WorkflowInput): ValueType => type;

type InputProblem = { name: string; message: string };

const decimalPattern = /^\s*-?\d+(\.\d+)?\s*$/;

// A form gives each value as text.
const convert = (type: ValueType, value: InputValue): InputValue | undefined => {
  if (typeof value === type) return value;
  if (typeof value !== "string") return undefined;
  if (type === "number") {
    const number = Number(value);
    return decimalPattern.test(value) && Number.isFinite(number) ? number : undefined;
  }
  if (type === "boolean" && (value === "true" || value === "false")) return value === "true";
  return undefined;
};

// A blank form field takes the default.
export const resolveInputs = (
  declared: Record<string, WorkflowInput> = {},
  given: Inputs = {},
): Result<Inputs, InputProblem> => {
  const problems: InputProblem[] = Object.keys(given)
    .filter((name) => !Object.hasOwn(declared, name))
    .map((name) => ({ name, message: "The workflow has no such input" }));
  const inputs: Inputs = {};
  for (const [name, input] of Object.entries(declared)) {
    const value = Object.hasOwn(given, name) && given[name] !== "" ? given[name] : input.default;
    if (value === undefined) {
      if (input.required) problems.push({ name, message: "Give a value" });
      continue;
    }
    const type = inputTypeOf(input);
    const converted = convert(type, value);
    if (converted === undefined) problems.push({ name, message: typeHints[type] });
    else inputs[name] = converted;
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: inputs };
};
