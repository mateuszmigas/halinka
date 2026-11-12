import { isAbsolute, join } from "node:path";

import { invalidDefinitions, invalidInput } from "@halinka/protocol";
import { hostGit } from "@halinka/sandbox/host";
import { findRealPath, isFolder, isInsideFolder, pathExists } from "@halinka/utils/fs";
import { definitionsFolder } from "@halinka/workflow";

export const requireAbsolute = (path: string) => {
  if (!isAbsolute(path)) throw invalidInput(`"${path}" is not an absolute path`);
};

// `.git` is a file in a worktree and a folder in a clone.
export const isRepoRoot = (path: string) => pathExists(join(path, ".git"));

// A blob read or a devcontainer list must not fail on a bad `.halinka/` of the working tree.
export const openRepo = async (repoPath: string) => {
  requireAbsolute(repoPath);
  if (!(await isFolder(repoPath))) throw invalidInput(`${repoPath} is not a folder`);
  const git = hostGit(repoPath);
  if (!(await git.findRoot())) throw invalidInput(`${repoPath} is not a git repo`);
  return { git, root: (await findRealPath(repoPath)) ?? repoPath };
};

export const openDefinitions = async (repoPath: string) => {
  const repo = await openRepo(repoPath);
  const folder = await findRealPath(join(repoPath, definitionsFolder));
  if (folder && (folder === repo.root || !isInsideFolder(folder, repo.root))) {
    throw invalidDefinitions(`${definitionsFolder}/ in ${repoPath} points outside the repo`);
  }
  if (folder && !(await isFolder(folder))) {
    throw invalidDefinitions(`${definitionsFolder} in ${repoPath} is not a folder`);
  }
  return { ...repo, folder };
};
