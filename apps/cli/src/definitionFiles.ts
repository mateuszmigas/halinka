import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { errnoCode } from "@halinka/utils/errors";
import { isFile } from "@halinka/utils/fs";
import { type Problem, toWorkflowPath, workflowsFolder } from "@halinka/workflow";

export const problemLines = (path: string, problems: Problem[]) =>
  problems.map(({ line, column, message }) => `${path}:${line}:${column} ${message}`);

export const findWorkflowPaths = async (root: string) => {
  const names = await readdir(join(root, workflowsFolder)).catch((error: unknown) => {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  });
  const paths = names.flatMap((name) => toWorkflowPath(name) ?? []);
  const found = await Promise.all(paths.map((path) => isFile(join(root, path))));
  return paths.filter((_, index) => found[index]);
};
