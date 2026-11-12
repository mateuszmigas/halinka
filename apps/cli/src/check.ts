import { join } from "node:path";

import { agentPresets } from "@halinka/presets";
import { isFile, readTextFile } from "@halinka/utils/fs";
import { parseRepoConfig, parseWorkflow, repoConfigPath, workflowsFolder } from "@halinka/workflow";

import { fail, failWithError, parseCommandArgs } from "./args";
import { findWorkflowPaths, problemLines } from "./definitionFiles";
import { findRepoRoot } from "./findRepoRoot";
import { safeText } from "./safeText";

const usage = `Usage: halinka check [options]

Checks .halinka/config.yml and the workflows of this repo. It reads only the files of the repo and needs no server.

Options:
  --repo <path>  The repo, if it is not the repo of the current folder`;

const checkConfig = async (root: string) => {
  const source = await readTextFile(join(root, repoConfigPath));
  if (source === undefined) return [`${repoConfigPath} does not exist. Run halinka init.`];
  const config = parseRepoConfig(source);
  if (!config.ok) return problemLines(repoConfigPath, config.problems);
  const { devcontainer } = config.value;
  return devcontainer && !(await isFile(join(root, devcontainer)))
    ? [`${repoConfigPath} names the devcontainer ${devcontainer}, and that file does not exist.`]
    : [];
};

const checkWorkflow = async (root: string, path: string) => {
  const parsed = parseWorkflow((await readTextFile(join(root, path))) ?? "", {
    agents: agentPresets,
  });
  return parsed.ok ? [] : problemLines(path, parsed.problems);
};

export const checkRepo = async (root: string) => {
  const paths = await findWorkflowPaths(root);
  const [config, workflows] = await Promise.all([
    checkConfig(root),
    Promise.all(paths.map((path) => checkWorkflow(root, path))),
  ]);
  const problems = [...config, ...workflows.flat()];
  return {
    workflows: paths.length,
    problems: paths.length > 0 ? problems : [...problems, `${workflowsFolder} has no workflow.`],
  };
};

export const check = async (args: string[]) => {
  const flags = parseCommandArgs(args, { repo: { type: "string" } }, usage);
  const root = await findRepoRoot(flags.repo);
  const { problems, workflows } = await checkRepo(root).catch(failWithError);
  if (problems.length > 0) fail(safeText(problems.join("\n")));
  console.log(
    `The config is valid. Workflows checked: ${workflows}. This does not check keys, runners, secrets or the devcontainer build.`,
  );
};
