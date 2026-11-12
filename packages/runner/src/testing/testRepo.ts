import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { hostGit } from "@halinka/sandbox/host";
import { ensureFolder } from "@halinka/utils/fs";
import { tempFolder } from "@halinka/utils/testing";

export const identity = { "user.name": "Halinka Test", "user.email": "test@halinka.local" };

export const commitFile = async (repoPath: string, file: string) => {
  const git = hostGit(repoPath, identity);
  await writeFile(join(repoPath, file), `${file}\n`);
  await git.run("add", ".");
  await git.run("commit", "--quiet", "-m", file);
  return git.run("rev-parse", "HEAD");
};

export const commitAll = async (repoPath: string, message: string) => {
  const git = hostGit(repoPath, identity);
  await git.run("add", "--all");
  await git.run("commit", "--quiet", "-m", message);
  return git.run("rev-parse", "HEAD");
};

export const writeDefinition = async (repoPath: string, path: string, content: string | Buffer) => {
  await ensureFolder(dirname(join(repoPath, path)));
  await writeFile(join(repoPath, path), content);
};

export const createRepo = async ({ commit = true } = {}) => {
  const repoPath = await tempFolder();
  await hostGit(repoPath).run("init", "--quiet");
  if (commit) await commitFile(repoPath, "README.md");
  return repoPath;
};
