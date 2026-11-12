import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import { alternatives, type JsonSchema, workflowJsonSchema } from "./workflowJsonSchema";

type Completion = { label: string; insertText: string; kind: "key" | "value" };

const marker = "__halinka_completion__";

const isMarker = (node: unknown) => isScalar(node) && node.value === marker;

const keyOf = (key: unknown) => (isScalar(key) ? String(key.value) : "");

const unique = (names: string[]) => [...new Set(names)];

const asValues = (schemas: JsonSchema[]) =>
  unique(
    schemas.flatMap((schema) => {
      if (schema.type === "boolean") return ["true", "false"];
      return schema.enum ?? (schema.const === undefined ? [] : [schema.const]);
    }),
  ).map((name): Completion => ({ label: name, insertText: name, kind: "value" }));

const walk = (node: unknown, schemas: JsonSchema[]): Completion[] | undefined => {
  if (isMarker(node)) return asValues(schemas);
  if (isSeq(node)) {
    const items = schemas.flatMap((schema) => (schema.items ? alternatives(schema.items) : []));
    for (const item of node.items) {
      const found = walk(item, items);
      if (found) return found;
    }
    return undefined;
  }
  if (!isMap(node)) return undefined;

  const type = node.get("type", true);
  const typed = schemas.filter(
    (schema) => isScalar(type) && schema.properties?.type?.const === type.value,
  );
  const candidates = typed.length > 0 ? typed : schemas;

  for (const { key, value } of node.items) {
    if (isMarker(key)) {
      const used = new Set(node.items.map((pair) => keyOf(pair.key)));
      const keys = unique(candidates.flatMap((schema) => Object.keys(schema.properties ?? {})))
        .filter((name) => !used.has(name))
        .map((name): Completion => ({ label: name, insertText: name, kind: "key" }));
      return [...keys, ...asValues(candidates)];
    }
    const children = candidates.flatMap((schema) => {
      const child =
        schema.properties?.[keyOf(key)] ??
        (typeof schema.additionalProperties === "object" ? schema.additionalProperties : undefined);
      return child ? alternatives(child) : [];
    });
    const found = walk(value, children);
    if (found) return found;
  }
  return undefined;
};

export const workflowCompletions = (source: string, offset: number) => {
  const lineStart = source.slice(0, offset).lastIndexOf("\n") + 1;
  const start = lineStart + source.slice(lineStart, offset).search(/[\w-]*$/);
  const end = offset + source.slice(offset).search(/[^\w-]|$/);

  const before = source.slice(lineStart, start);
  const isKey = /^\s*(-\s+)*$/.test(before);
  if (!isKey && !/:\s+$/.test(before)) return { start, end, items: [] };

  const rest = source.slice(end);
  const hasColon = /^\s*:/.test(rest);
  const placeholder = isKey && !hasColon ? `${marker}:` : marker;
  const document = parseDocument(source.slice(0, start) + placeholder + rest);
  const items = (walk(document.contents, [workflowJsonSchema()]) ?? []).map((item) =>
    item.kind === "key" && !hasColon ? { ...item, insertText: `${item.label}: ` } : item,
  );
  return { start, end, items };
};
