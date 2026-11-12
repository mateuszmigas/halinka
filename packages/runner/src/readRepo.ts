import { opendir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import {
  invalidDefinitions,
  invalidInput,
  type RepoFile,
  type RunnerCommands,
} from "@halinka/protocol";
import { errnoCode } from "@halinka/utils/errors";
import { findFileSize, findRealPath, isInsideFolder } from "@halinka/utils/fs";
import { hashOf } from "@halinka/utils/hash";
import { maxFileMib, maxFiles, maxTotalMib, mib } from "@halinka/utils/repoFiles";
import { definitionsFolder } from "@halinka/workflow";

import { openDefinitions } from "./repoFiles";

const definitionPath = (folder: string, path: string) =>
  [definitionsFolder, ...relative(folder, path).split(sep)].join("/");

const refuseUnreadable =
  (folder: string) =>
  (error: unknown): never => {
    const code = errnoCode(error);
    const path = error instanceof Error && "path" in error ? error.path : undefined;
    if ((code === "EACCES" || code === "EPERM") && typeof path === "string") {
      throw invalidDefinitions(`${definitionPath(folder, path)} cannot be read`);
    }
    throw error;
  };

const readDefinition = async (real: string): Promise<RepoFile> => {
  const bytes = await readFile(real);
  return { source: bytes.toString("utf8"), hash: hashOf(bytes) };
};

const readDefinitions = async (folder: string) => {
  const found: { path: string; real: string }[] = [];
  let total = 0;
  for await (const entry of await opendir(folder, { recursive: true })) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const full = join(entry.parentPath, entry.name);
    const real = entry.isFile() ? full : await findRealPath(full);
    if (!real || !isInsideFolder(real, folder)) continue;
    const size = await findFileSize(real);
    if (size === undefined) continue;
    const path = definitionPath(folder, full);
    if (size > maxFileMib * mib) {
      throw invalidDefinitions(`${path} is larger than ${maxFileMib} MiB`);
    }
    found.push({ path, real });
    total += size;
    if (found.length > maxFiles) {
      throw invalidDefinitions(`${definitionsFolder}/ has more than ${maxFiles} files`);
    }
    if (total > maxTotalMib * mib) {
      throw invalidDefinitions(`${definitionsFolder}/ is larger than ${maxTotalMib} MiB`);
    }
  }
  return Object.fromEntries(
    await Promise.all(found.map(async ({ path, real }) => [path, await readDefinition(real)])),
  );
};

export const readRepo: RunnerCommands["readRepo"] = async ({ repoPath }) => {
  const { git, root, folder } = await openDefinitions(repoPath);
  const head = await git.findCommit("HEAD");
  if (!head) throw invalidInput(`${repoPath} has no commit`);
  const files = folder ? await readDefinitions(folder).catch(refuseUnreadable(folder)) : {};
  return { realPath: root, head, files };
};
