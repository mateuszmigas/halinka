import { errorMessage } from "@halinka/utils/errors";
import type { Result } from "@halinka/utils/result";
import {
  type Document,
  type YAMLMap,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  visit,
} from "yaml";

import { formFieldsOf, type StepField, stepFieldNames } from "./formFields";

export type GateFields = { name: string; run: string; on_fail: string };

export type StepFields = Record<StepField, string> & {
  type: string;
  gates: GateFields[] | undefined;
  children?: StepFields[];
};

export type StepEdit = (
  | { type: "add_shell"; at?: number }
  | { type: "add_agent"; agent: string; at?: number }
  | { type: "add_approval"; at?: number }
  | { type: "add_github"; at?: number }
  | { type: "add_loop"; at?: number }
  | { type: "set"; index: number; field: StepField; value: string }
  | { type: "add_gate"; index: number }
  | { type: "set_gate"; index: number; gate: number; field: keyof GateFields; value: string }
  | { type: "delete_gate"; index: number; gate: number }
  | { type: "move"; index: number; to: number }
  | { type: "delete"; index: number }
) & { parent?: number };

const stepDocument = (source: string) => {
  const document = parseDocument(source);
  if (document.errors.length > 0 || document.warnings.length > 0 || !isMap(document.contents)) {
    return undefined;
  }
  const steps = document.get("steps");
  if (!isSeq(steps)) return undefined;
  const items = steps.items;
  if (!items.every(isMap)) return undefined;
  return { document, items };
};

const scalarText = (value: unknown, document: Document) => {
  const node = isAlias(value) ? value.resolve(document) : value;
  if (!isScalar(node)) return "";
  if (typeof node.value === "number" && node.source) return node.source;
  return typeof node.value === "string" ||
    typeof node.value === "number" ||
    typeof node.value === "boolean"
    ? String(node.value)
    : "";
};

const numberNode = (text: string) => {
  const parsed = parseDocument(text);
  return isScalar(parsed.contents) &&
    typeof parsed.contents.value === "number" &&
    parsed.toString() === `${text}\n`
    ? parsed.contents
    : undefined;
};

type UnchangedOptions = { value: unknown; text: string };

const isUnchanged = (current: unknown, document: Document, { value, text }: UnchangedOptions) => {
  const node = isAlias(current) ? current.resolve(document) : current;
  const next = isScalar(value) ? value.value : value;
  return isScalar(node) && typeof node.value === typeof next && scalarText(node, document) === text;
};

const parseGates = (value: unknown, document: Document): GateFields[] | undefined => {
  if (!isSeq(value) || !value.items.every(isMap)) return undefined;
  return value.items.map((gate) => ({
    name: scalarText(gate.get("name", true), document),
    run: scalarText(gate.get("run", true), document),
    on_fail: scalarText(gate.get("on_fail", true), document),
  }));
};

const addStepEdits = ["add_shell", "add_agent", "add_approval", "add_github", "add_loop"] as const;

export const isAddStep = (
  edit: StepEdit,
): edit is Extract<StepEdit, { type: (typeof addStepEdits)[number] }> =>
  addStepEdits.some((type) => type === edit.type);

export const parseStepFields = (source: string): StepFields[] | undefined => {
  const parsed = stepDocument(source);
  const parseFields = (items: YAMLMap[], document: Document): StepFields[] =>
    items.map((step) => {
      const text = (key: string) => scalarText(step.get(key, true), document);
      const children = step.get("steps");
      return {
        ...(Object.fromEntries(stepFieldNames.map((name) => [name, text(name)])) as Record<
          StepField,
          string
        >),
        type: text("type"),
        gates: !step.has("gates") ? [] : parseGates(step.get("gates"), document),
        ...(text("type") === "loop"
          ? {
              children:
                isSeq(children) && children.items.every(isMap)
                  ? parseFields(children.items, document)
                  : undefined,
            }
          : {}),
      };
    });
  return parsed ? parseFields(parsed.items, parsed.document) : undefined;
};

const freeName = (prefix: string, taken: Set<string>) => {
  let number = 1;
  while (taken.has(`${prefix}_${number}`)) number++;
  return `${prefix}_${number}`;
};

const refuse = (problem: string): Result<string> => ({ ok: false, problems: [problem] });

export const editSteps = (source: string, edit: StepEdit): Result<string> => {
  const parsed = stepDocument(source);
  if (!parsed) return refuse("Use the YAML editor to correct the step list.");
  const { document } = parsed;
  let items = parsed.items;
  if (edit.parent !== undefined) {
    const parent = parsed.items[edit.parent];
    if (
      !Number.isInteger(edit.parent) ||
      !parent ||
      scalarText(parent.get("type", true), document) !== "loop"
    )
      return refuse("The loop does not exist.");
    const children = parent.get("steps");
    if (!isSeq(children) || !children.items.every(isMap))
      return refuse("Use the YAML editor to correct the child steps.");
    items = children.items;
  }

  if (isAddStep(edit)) {
    if (edit.type === "add_loop" && edit.parent !== undefined) {
      return refuse("A loop cannot hold a loop.");
    }
    const type = edit.type.slice(4);
    const ids = new Set<string>();
    visit(document, {
      Map: (_, map) => {
        const id = scalarText(map.get("id", true), document);
        if (id) ids.add(id);
      },
    });
    const addedFields = () => {
      if (edit.type === "add_shell") return { run: "echo hello" };
      if (edit.type === "add_agent") return { agent: edit.agent, prompt: "Describe the task." };
      if (edit.type === "add_github") return { action: "open_pull_request" };
      if (edit.type === "add_approval") return { message: "Review the changes." };
      const child = freeName("shell", ids);
      return {
        max_iterations: 3,
        until: `\${{ steps.${child}.status == 'succeeded' }}`,
        steps: [{ id: child, type: "shell", run: "echo hello" }],
      };
    };
    const fields = addedFields();
    const at = edit.at ?? items.length;
    if (!Number.isInteger(at) || at < 0 || at > items.length)
      return refuse("The step position does not exist.");
    items.splice(at, 0, document.createNode({ id: freeName(type, ids), type, ...fields }));
  } else {
    const step = items[edit.index];
    if (!Number.isInteger(edit.index) || !step) return refuse("The step does not exist.");
    if (edit.type === "set") {
      const type = scalarText(step.get("type", true), document);
      const field = formFieldsOf(type)?.find(({ name }) => name === edit.field);
      if (!field) return refuse("Use the YAML editor to edit this step.");
      if (field.isOptional && edit.value === "") {
        if (!step.has(edit.field)) return { ok: true, value: source };
        step.delete(edit.field);
      } else {
        const value = field.isNumeric ? (numberNode(edit.value) ?? edit.value) : edit.value;
        if (isUnchanged(step.get(edit.field, true), document, { value, text: edit.value }))
          return { ok: true, value: source };
        step.set(edit.field, value);
      }
    } else if (
      edit.type === "add_gate" ||
      edit.type === "set_gate" ||
      edit.type === "delete_gate"
    ) {
      if (scalarText(step.get("type", true), document) !== "agent")
        return refuse("Only agent steps have gates.");
      if (!step.has("gates") && edit.type === "add_gate")
        step.set("gates", document.createNode([]));
      const gates = step.get("gates");
      if (!isSeq(gates) || !gates.items.every(isMap))
        return refuse("Use the YAML editor to correct the gate list.");
      if (edit.type === "add_gate") {
        const names = new Set(
          gates.items.map((gate) => scalarText(gate.get("name", true), document)),
        );
        gates.add(document.createNode({ name: freeName("gate", names), run: "echo hello" }));
      } else {
        const gate = gates.items[edit.gate];
        if (!Number.isInteger(edit.gate) || !gate) return refuse("The gate does not exist.");
        if (edit.type === "delete_gate") gates.items.splice(edit.gate, 1);
        else if (edit.field === "on_fail" && edit.value === "") {
          if (!gate.has(edit.field)) return { ok: true, value: source };
          gate.delete(edit.field);
        } else if (
          isUnchanged(gate.get(edit.field, true), document, { value: edit.value, text: edit.value })
        )
          return { ok: true, value: source };
        else gate.set(edit.field, edit.value);
      }
    } else if (edit.type === "delete") {
      items.splice(edit.index, 1);
    } else {
      if (!Number.isInteger(edit.to) || edit.to < 0 || edit.to >= items.length) {
        return refuse("The step position does not exist.");
      }
      if (edit.index === edit.to) return { ok: true, value: source };
      items.splice(edit.index, 1);
      items.splice(edit.to, 0, step);
    }
  }

  try {
    return { ok: true, value: document.toString() };
  } catch (error) {
    return refuse(errorMessage(error));
  }
};
