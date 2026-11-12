import type { Agents } from "./agents";
import { isWorkflowPath } from "./paths";
import { parseRepoConfig, repoConfigPath } from "./repoConfig";
import { parseWorkflow } from "./workflow";

export const isRepoConfig = (path: string) => {
  if (path === repoConfigPath) return true;
  if (isWorkflowPath(path)) return false;
  throw new Error(`${path} is not a Halinka definition`);
};

export const parseDefinition = (
  path: string,
  source: string,
  { agents }: { agents?: Agents } = {},
) => (isRepoConfig(path) ? parseRepoConfig(source) : parseWorkflow(source, { agents }));
