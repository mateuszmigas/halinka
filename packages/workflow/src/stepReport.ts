import { isRecord } from "@halinka/utils/isRecord";
import { z } from "zod";

import { identifierHint, isIdentifier } from "./identifier";

export const reportServerName = "halinka";

const valueSchemas = { string: z.string(), number: z.number(), boolean: z.boolean() };
const outcomeResults = ["ok", "fail"] as const;

export type ValueType = keyof typeof valueSchemas;

type ArrayType = { type: "array"; items: OutputType };

export type OutputType = ValueType | ArrayType | OutputFields;

export type OutputFields = { [name: string]: OutputType };

export type Outcomes = string[] | Record<string, (typeof outcomeResults)[number]>;

export type StepReport = { summary: string; outcome?: string; outputs?: Record<string, unknown> };

export type ReportSchema = z.ZodType<StepReport>;

export type ReportShape = { outcomes?: Outcomes; outputs?: OutputFields };

type Path = (string | number)[];
type AddIssue = (path: Path, message: string) => void;

export const isValueType = (type: unknown): type is ValueType =>
  typeof type === "string" && Object.hasOwn(valueSchemas, type);

export const isArrayType = (type: ArrayType | OutputFields): type is ArrayType =>
  type.type === "array";

const keyNames = (map: Record<string, unknown>) =>
  Object.keys(map).map((name): [string, string] => [name, name]);

type CheckNamesOptions = { term: string; path?: Path };

const checkNames = (
  names: [string | number, unknown][],
  addIssue: AddIssue,
  { term, path = [] }: CheckNamesOptions,
) => {
  if (names.length === 0) addIssue(path, `Add at least one ${term}`);
  const seen = new Set<unknown>();
  for (const [key, name] of names) {
    if (typeof name !== "string") addIssue([...path, key], "Use a string");
    else if (!isIdentifier(name)) addIssue([...path, key], identifierHint);
    else if (seen.has(name)) addIssue([...path, key], `The ${term} "${name}" is already used`);
    seen.add(name);
  }
};

const checkOutcomes = (outcomes: unknown, addIssue: AddIssue) => {
  if (Array.isArray(outcomes))
    return checkNames([...outcomes.entries()], addIssue, { term: "outcome" });
  if (!isRecord(outcomes))
    return addIssue([], "Use a list of outcomes or a map with ok or fail values");
  checkNames(keyNames(outcomes), addIssue, { term: "outcome" });
  for (const [outcome, result] of Object.entries(outcomes)) {
    if (!outcomeResults.includes(result as never)) addIssue([outcome], "Use ok or fail");
  }
};

const checkFields = (fields: unknown, addIssue: AddIssue, path: Path = []) => {
  if (!isRecord(fields)) return addIssue(path, "Use a map");
  checkNames(keyNames(fields), addIssue, { term: "field", path });
  for (const [name, type] of Object.entries(fields)) checkType(type, addIssue, [...path, name]);
};

const checkType = (type: unknown, addIssue: AddIssue, path: Path): void => {
  if (isValueType(type)) return;
  if (type == null) return addIssue(path, "Required");
  if (!isRecord(type)) {
    const valueTypes = Object.keys(valueSchemas).join(", ");
    return addIssue(path, `Use ${valueTypes}, a map of fields or { type: array, items }`);
  }
  if (type.type !== "array") return checkFields(type, addIssue, path);
  for (const key of Object.keys(type)) {
    if (key !== "type" && key !== "items") addIssue([...path, key], "Unknown key");
  }
  checkType(type.items, addIssue, [...path, "items"]);
};

const checked = <T>(check: (value: unknown, addIssue: AddIssue) => void) =>
  z.custom<T>().superRefine((value, context) => {
    const addIssue: AddIssue = (path, message) =>
      context.addIssue({ code: "custom", path, message });
    if (value == null) addIssue([], "Required");
    else check(value, addIssue);
  });

export const outcomesSchema = checked<Outcomes>(checkOutcomes);

export const outputsSchema = checked<OutputFields>(checkFields);

const valueSchema = (type: OutputType): z.ZodType => {
  if (typeof type === "string") return valueSchemas[type];
  if (isArrayType(type)) return z.array(valueSchema(type.items));
  return fieldsSchema(type);
};

const fieldsSchema = (fields: OutputFields) =>
  z.strictObject(
    Object.fromEntries(Object.entries(fields).map(([name, type]) => [name, valueSchema(type)])),
  );

export const approvalOutcomes = { approve: "approved", reject: "rejected" } as const;

export const outcomeNames = (outcomes: Outcomes) =>
  Array.isArray(outcomes) ? outcomes : Object.keys(outcomes);

export const outcomeResult = (outcomes: Outcomes | undefined, outcome: string | undefined) => {
  if (!outcomes || Array.isArray(outcomes) || outcome === undefined) return "ok";
  return Object.hasOwn(outcomes, outcome) ? (outcomes[outcome] ?? "ok") : "ok";
};

// The schema depends on the step, so give it one fixed type.
export const reportSchema = (step: ReportShape) =>
  z.strictObject({
    summary: z.string().min(1).describe("A short summary of what you did or found"),
    ...(step.outcomes && {
      outcome: z
        .enum(outcomeNames(step.outcomes))
        .describe("The outcome of your task: one of the listed values"),
    }),
    ...(step.outputs && {
      outputs: fieldsSchema(step.outputs).describe("The data that your task asks for"),
    }),
  }) as ReportSchema;
