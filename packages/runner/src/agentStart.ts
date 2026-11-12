import { AcpAgent, type AgentStart } from "@halinka/agents/acp";
import { FileReportChannel } from "@halinka/agents/fileReportChannel";
import { type AgentPreset, agentPresets, findAgentPreset, packageAt } from "@halinka/presets";
import type { ClaimedRun, StoredCredential } from "@halinka/protocol";
import { workflowAgents } from "@halinka/workflow";

import type { CodexLogins } from "./codexLogins";
import type { CredentialScope } from "./credentials";

export const agentPackageOf = (preset: AgentPreset, version?: string) => ({
  command: preset.command[0]!,
  package: packageAt(preset, version),
});

export const agentPackagesOf = ({ workflow, agentVersions }: ClaimedRun) =>
  workflowAgents(workflow).flatMap((agent) => {
    const preset = findAgentPreset(agent);
    return preset ? [agentPackageOf(preset, agentVersions[agent])] : [];
  });

type StartAgent = (preset: AgentPreset) => Promise<AgentStart>;

export const agentOf = (preset: AgentPreset, startAgent: StartAgent) =>
  new AcpAgent(
    async () => {
      const { command, launch } = await startAgent(preset);
      return { command, launch: { ...launch, env: { ...preset.env, ...launch.env } } };
    },
    FileReportChannel.create,
    preset.tools?.sessionMeta,
  );

export const agentsWith = (startAgent: StartAgent) =>
  new Map(
    Object.values(agentPresets).map((preset) => [preset.id, agentOf(preset, startAgent)] as const),
  );

// A host agent has the runner's environment.
export const startHostAgent: StartAgent = async ({ command }) => ({ command, launch: {} });

type AgentStartDeps = {
  scope: Pick<CredentialScope, "setStored" | "hasStored" | "launch">;
  codexLogins: Pick<CodexLogins, "readForStart">;
  readStored: (preset: string) => Promise<StoredCredential[]>;
};

export const containerAgentStart =
  ({ scope, codexLogins, readStored }: AgentStartDeps) =>
  async (preset: AgentPreset) => {
    scope.setStored(preset, await readStored(preset.id));
    // An expired login must not stop an agent that does not use it.
    if (preset.login && !scope.hasStored(preset)) await codexLogins.readForStart();
    return scope.launch(preset);
  };
