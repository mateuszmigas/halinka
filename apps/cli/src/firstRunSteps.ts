import { basename, join } from "node:path";

import { findAgentPreset } from "@halinka/presets";
import type { SandboxKind } from "@halinka/protocol";
import { createApiClient } from "@halinka/server/client";
import { readTextFile } from "@halinka/utils/fs";
import { parseWorkflow, smokePath, workflowAgents } from "@halinka/workflow";

export type FirstRunOptions = {
  server: string;
  repoId: number;
  root: string;
  sandboxKind: SandboxKind;
};

export const firstRunSteps = async ({ server, repoId, root, sandboxKind }: FirstRunOptions) => {
  const api = createApiClient(server, {});
  const [{ runs }, source, agents] = await Promise.all([
    api.runs.list({ repoId, limit: 1 }),
    readTextFile(join(root, smokePath)),
    sandboxKind === "devcontainer" ? api.agents.list() : [],
  ]);
  if (runs.length > 0 || source === undefined) return [];
  const smoke = parseWorkflow(source);
  if (!smoke.ok) return [];
  // The runner of start runs in this process and also lends a key from its environment.
  const hasKey = (preset: string) =>
    agents
      .find((agent) => agent.preset === preset)
      ?.credentials.some(({ state }) => state === "set") ||
    findAgentPreset(preset)?.credentials.some(({ variable }) => Boolean(process.env[variable]));
  const keyStep = (preset: string) => {
    const agent = agents.find((item) => item.preset === preset);
    if (agent?.credentials.some(({ state }) => state === "unreadable")) {
      return [`Enter the key of ${preset} again on the Agents page: ${server}/agents`];
    }
    return hasKey(preset) ? [] : [`Add a key of ${preset} on the Agents page: ${server}/agents`];
  };
  const keySteps =
    sandboxKind === "devcontainer"
      ? workflowAgents(smoke.value)
          .filter((preset) => findAgentPreset(preset))
          .flatMap(keyStep)
      : [];
  const workflowLink = `${server}/repos/${repoId}/workflows/${basename(smokePath)}`;
  return [...keySteps, `Start the smoke workflow: ${workflowLink}`];
};
