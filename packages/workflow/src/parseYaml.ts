import { errorMessage } from "@halinka/utils/errors";
import type { Result } from "@halinka/utils/result";
import {
  type Document,
  isMap,
  isNode,
  isScalar,
  isSeq,
  LineCounter,
  type Pair,
  parseDocument,
  type Scalar,
  visit,
} from "yaml";
import type { z } from "zod";

export type Problem = {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  path: (string | number)[];
  message: string;
};

const yamlTypeNames: Record<string, string> = { object: "map", array: "list", int: "whole number" };

const errorMap: z.core.$ZodErrorMap = (issue) => {
  if (issue.code === "unrecognized_keys") return "Unknown key";
  if (issue.code !== "invalid_type") return undefined;
  if (issue.input == null) return "Required";
  return `Use a ${yamlTypeNames[issue.expected] ?? issue.expected}`;
};

export const nodeRange = (node: unknown): [number, number] => {
  const range = isNode(node) ? node.range : undefined;
  return range ? [range[0], range[1]] : [0, 0];
};

const rangeAt = (document: Document, source: string, path: Problem["path"]): [number, number] => {
  let node: unknown = document.contents;
  let start = document.contents?.range?.[0] ?? 0;
  let end = document.contents?.range?.[1] ?? start;
  const toEndOfLine = () => {
    const lineEnd = source.indexOf("\n", start);
    return lineEnd === -1 ? end : Math.min(end, lineEnd);
  };
  for (const key of path) {
    if (isMap(node)) {
      const pair = node.items.find(
        (item): item is Pair<Scalar> =>
          isScalar(item.key) && String(item.key.value) === String(key),
      );
      if (!pair) return [start, toEndOfLine()];
      start = pair.key.range?.[0] ?? start;
      end =
        (isNode(pair.value) ? pair.value.range?.[1] : undefined) ?? pair.key.range?.[1] ?? start;
      node = pair.value;
    } else if (isSeq(node) && typeof key === "number") {
      const item = node.items[key];
      if (!isNode(item)) return [start, toEndOfLine()];
      start = item.range?.[0] ?? start;
      end = item.range?.[1] ?? start;
      node = item;
    } else {
      return [start, toEndOfLine()];
    }
  }
  return [start, end];
};

const byPosition = (a: Problem, b: Problem) => a.line - b.line || a.column - b.column;

// `removedKeys`: the reason of each key that an older schema had, by key name
export type ParseYamlOptions = { removedKeys?: ReadonlyMap<string, string> };

export const parseYaml = <T>(
  schema: z.ZodType<T>,
  source: string,
  { removedKeys = new Map() }: ParseYamlOptions = {},
): Result<T, Problem> => {
  const lineCounter = new LineCounter();
  const document = parseDocument(source, { lineCounter, prettyErrors: false });
  const problemAt = (
    [start, end]: [number, number],
    message: string,
    path: Problem["path"] = [],
  ): Problem => {
    const { line, col } = lineCounter.linePos(start);
    const { line: endLine, col: endColumn } = lineCounter.linePos(end);
    return { line, column: col, endLine, endColumn, path, message };
  };
  const fail = (problems: Problem[]): Result<T, Problem> => ({
    ok: false,
    problems: problems.sort(byPosition),
  });

  const yamlProblems = [...document.errors, ...document.warnings].map(({ code, message, pos }) =>
    problemAt(pos, code === "MULTIPLE_DOCS" ? "Use one YAML document" : message),
  );
  if (document.directives.yaml.version !== "1.2")
    yamlProblems.push(problemAt([0, 0], "Use YAML 1.2"));
  visit(document, {
    Pair: (_, pair) => {
      const range = nodeRange(pair.key);
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        yamlProblems.push(problemAt(range, "Use a string key"));
      } else if (pair.key.value === "<<") {
        yamlProblems.push(problemAt(range, "Do not use merge keys (<<). Write the keys"));
      } else if (pair.key.value === "__proto__") {
        // zod drops this key from a record without a problem.
        yamlProblems.push(problemAt(range, "Do not use the key __proto__"));
      }
    },
    Alias: (_, alias, path) => {
      const source = alias.resolve(document);
      if (source && path.includes(source)) {
        yamlProblems.push(problemAt(nodeRange(alias), "Do not use an alias inside its own anchor"));
      }
    },
  });
  if (yamlProblems.length > 0) return fail(yamlProblems);

  let data: unknown;
  try {
    data = document.toJS();
  } catch (error) {
    return fail([problemAt([0, 0], errorMessage(error))]);
  }

  if (data == null) return fail([problemAt([0, 0], "The file is empty")]);

  const result = schema.safeParse(data, { error: errorMap });
  if (result.success) return { ok: true, value: result.data };

  return fail(
    result.error.issues.flatMap((issue) => {
      const path = issue.path.filter((key) => typeof key !== "symbol");
      if (issue.code !== "unrecognized_keys") {
        return [problemAt(rangeAt(document, source, path), issue.message, path)];
      }
      return issue.keys.map((key) => {
        const keyPath = [...path, key];
        const message = removedKeys.get(key) ?? issue.message;
        return problemAt(rangeAt(document, source, keyPath), message, keyPath);
      });
    }),
  );
};
