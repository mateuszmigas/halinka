import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { invalidDefinitions, invalidInput, type RunnerCommands } from "@halinka/protocol";
import { errnoCode, errorMessage } from "@halinka/utils/errors";
import { ensureFolder, findRealPath, isFile, isInsideFolder } from "@halinka/utils/fs";
import { isServerUrl } from "@halinka/utils/serverUrl";
import {
  createDevcontainer,
  createRepoConfig,
  createSmokeWorkflow,
  definitionsFolder,
  newDevcontainerPath,
  repoConfigPath,
  smokePath,
} from "@halinka/workflow";

import { isRepoRoot, openRepo } from "./repoFiles";

type ScaffoldFile = { path: string; content: string };

// The places that the devcontainer spec defines, in the order that tools show them.
export const findDevcontainers = async (root: string) => {
  const entries = await readdir(join(root, ".devcontainer"), { withFileTypes: true }).catch(
    () => [],
  );
  const named = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `.devcontainer/${entry.name}/devcontainer.json`)
    .sort();
  const candidates = [".devcontainer/devcontainer.json", ".devcontainer.json", ...named];
  const found = await Promise.all(candidates.map((path) => isFile(join(root, path))));
  return candidates.filter((_, index) => found[index]);
};

const scaffoldFiles = (server: string, devcontainer: string | undefined, found: string[]) => [
  {
    path: repoConfigPath,
    content: createRepoConfig({ server, devcontainer }),
  },
  ...(devcontainer && !found.includes(devcontainer)
    ? [{ path: devcontainer, content: createDevcontainer() }]
    : []),
  { path: smokePath, content: createSmokeWorkflow() },
];

// All files or none, so that a setup can run again after a failure. The caller created `.halinka/`.
const writeRepoFiles = async (root: string, files: ScaffoldFile[]) => {
  const written: string[] = [];
  for (const file of files) {
    const path = join(root, file.path);
    try {
      await ensureFolder(dirname(path));
      await writeFile(path, file.content, { flag: "wx" });
      written.push(path);
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") written.push(path);
      await Promise.all(written.map((item) => rm(item, { force: true }))).catch(() => {});
      await rm(join(root, definitionsFolder), { recursive: true, force: true }).catch(() => {});
      throw invalidDefinitions(`Halinka cannot write ${file.path}: ${errorMessage(error)}`);
    }
  }
};

// A link can point a new devcontainer outside the repo.
const requireInsideRepo = async (repoPath: string, path: string) => {
  const root = (await findRealPath(repoPath)) ?? repoPath;
  const folder = await findRealPath(join(repoPath, dirname(path)));
  if (folder && !isInsideFolder(folder, root)) {
    throw invalidInput(`${dirname(path)} in ${repoPath} points outside the repo`);
  }
};

// Only the setup that creates `.halinka/` writes into it.
const claimDefinitionsFolder = (repoPath: string) =>
  mkdir(join(repoPath, definitionsFolder)).catch((error: unknown) => {
    if (errnoCode(error) !== "EEXIST") throw error;
    throw invalidInput(`${repoPath} has .halinka/. Edit its files to change the settings`);
  });

const openRepoRoot = async (repoPath: string) => {
  await openRepo(repoPath);
  if (!(await isRepoRoot(repoPath)))
    throw invalidInput(`${repoPath} is not the root of a git repo`);
};

export const listDevcontainers: RunnerCommands["listDevcontainers"] = async ({ repoPath }) => {
  await openRepoRoot(repoPath);
  return findDevcontainers(repoPath);
};

export const setUpRepo: RunnerCommands["setUpRepo"] = async ({
  repoPath,
  server,
  devcontainer,
}) => {
  await openRepoRoot(repoPath);
  if (server !== "local" && !isServerUrl(server)) {
    throw invalidInput(`"${server}" is not "local" or a server URL`);
  }
  const found = await findDevcontainers(repoPath);
  if (devcontainer && devcontainer !== newDevcontainerPath && !found.includes(devcontainer)) {
    throw invalidInput(`${repoPath} has no devcontainer at ${devcontainer}`);
  }
  if (devcontainer && !found.includes(devcontainer))
    await requireInsideRepo(repoPath, devcontainer);
  const files = scaffoldFiles(server, devcontainer, found);
  await claimDefinitionsFolder(repoPath);
  await writeRepoFiles(repoPath, files);
  return { files: files.map(({ path }) => path) };
};
