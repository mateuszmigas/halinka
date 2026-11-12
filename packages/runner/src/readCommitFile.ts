import { invalidDefinitions, invalidInput, type RunnerCommands } from "@halinka/protocol";
import { isCommitId } from "@halinka/utils/git";
import { isRepoFilePath, maxFileMib, mib } from "@halinka/utils/repoFiles";

import { openRepo } from "./repoFiles";

export const readCommitFile: RunnerCommands["readCommitFile"] = async ({
  repoPath,
  commit,
  path,
}) => {
  if (!isCommitId(commit)) throw invalidInput(`"${commit}" is not a commit id`);
  if (!isRepoFilePath(path)) throw invalidInput(`"${path}" is not a path from the repo root`);
  const { git } = await openRepo(repoPath);
  if (!(await git.findCommit(commit))) throw invalidInput(`${repoPath} has no commit ${commit}`);
  const file = await git.findRegularFile(commit, path);
  if (!file) return undefined;
  if (file.size > maxFileMib * mib) {
    throw invalidDefinitions(`${path} is larger than ${maxFileMib} MiB`);
  }
  return { source: await git.readBlob(file.blob) };
};
