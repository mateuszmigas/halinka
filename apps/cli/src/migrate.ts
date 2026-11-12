import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { agentPresets } from "@halinka/presets";
import { errnoCode, errorMessage } from "@halinka/utils/errors";
import { readTextFile, replaceFile } from "@halinka/utils/fs";
import {
  type Migration,
  migrateDefinition,
  parseDefinition,
  repoConfigPath,
  schemaVersion,
} from "@halinka/workflow";

import { fail, failWithError, parseCommandArgs } from "./args";
import { findWorkflowPaths, problemLines } from "./definitionFiles";
import { findRepoRoot } from "./findRepoRoot";
import { safeText } from "./safeText";

const usage = `Usage: halinka migrate [options]

Changes the .halinka/ files of this repo that have no schema_version to schema_version ${schemaVersion}. Without --write, it only prints the changes.

Options:
  --write        Write the changes to the files
  --repo <path>  The repo, if it is not the repo of the current folder`;

type MigrateRepoOptions = { isWritten: boolean };

type MigratedDefinition = { path: string; source: string; mode: number; migration: Migration };

type Outcome = { problems: string[]; migrated?: MigratedDefinition };

const readDefinition = async (root: string, path: string): Promise<Outcome> => {
  const stats = await lstat(join(root, path)).catch((error: unknown) => {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (!stats) return { problems: [] };
  if (stats.isSymbolicLink()) {
    return { problems: [`${path} is a symbolic link. migrate does not change it.`] };
  }
  const source = (await readTextFile(join(root, path))) ?? "";
  try {
    const migration = migrateDefinition(path, source);
    const parsed = parseDefinition(path, migration.source, { agents: agentPresets });
    const problems = parsed.ok ? [] : problemLines(path, parsed.problems);
    return { problems, migrated: { path, source, mode: stats.mode & 0o777, migration } };
  } catch (error) {
    return { problems: [`${path} ${errorMessage(error)}`] };
  }
};

const writeDefinition = async (root: string, migrated: MigratedDefinition) => {
  const { path, source, mode, migration } = migrated;
  if ((await readTextFile(join(root, path))) !== source) {
    throw new Error("The file changed after migrate read it. Run halinka migrate again.");
  }
  await replaceFile(join(root, path), migration.source, mode);
};

export const migrateRepo = async (root: string, { isWritten }: MigrateRepoOptions) => {
  const paths = [repoConfigPath, ...(await findWorkflowPaths(root))];
  const outcomes = await Promise.all(paths.map((path) => readDefinition(root, path)));
  const changed = outcomes.flatMap(({ migrated }) =>
    migrated && migrated.migration.changes.length > 0 ? [migrated] : [],
  );
  const writes = isWritten
    ? await Promise.allSettled(changed.map((migrated) => writeDefinition(root, migrated)))
    : [];
  return {
    files: changed.length,
    changes: changed.flatMap(({ path, migration }) =>
      migration.changes.map(({ line, message }) => `${path}:${line} ${message}`),
    ),
    notes: [...new Set(changed.flatMap(({ migration }) => migration.notes))],
    failedWrites: changed.flatMap(({ path }, index) => {
      const write = writes[index];
      return write?.status === "rejected" ? [`${path} ${errorMessage(write.reason)}`] : [];
    }),
    problems: outcomes.flatMap(({ problems }) => problems),
  };
};

const summaryOf = (files: number, isWritten: boolean) => {
  if (files === 0) return "No file needs a change.";
  if (isWritten) return `Files changed: ${files}.`;
  return `Files to change: ${files}. Run halinka migrate --write to write them.`;
};

const section = (title: string, lines: string[]) => (lines.length > 0 ? [title, ...lines] : []);

export const migrate = async (args: string[]) => {
  const flags = parseCommandArgs(
    args,
    { write: { type: "boolean", default: false }, repo: { type: "string" } },
    usage,
  );
  const root = await findRepoRoot(flags.repo);
  const { files, changes, notes, failedWrites, problems } = await migrateRepo(root, {
    isWritten: flags.write,
  }).catch(failWithError);
  const report = [
    ...section("Changes, with the lines of the files before the migration:", changes),
    ...section("Notes:", notes),
    summaryOf(files - failedWrites.length, flags.write),
  ];
  console.log(safeText(report.join("\n")));
  const problemsTitle = flags.write
    ? "Problems that stay, with the lines of the files after the migration:"
    : "Problems that stay after the migration, with the lines that --write gives the files:";
  const failures = [
    ...section("Files that migrate could not write:", failedWrites),
    ...section(problemsTitle, problems),
  ];
  if (failures.length > 0) fail(safeText(failures.join("\n")));
};
