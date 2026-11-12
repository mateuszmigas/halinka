import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { agentPresets } from "@halinka/presets";
import type { Build, RunnerCapabilities, SandboxKind } from "@halinka/protocol";
import { hasSysboxRuntime, isDockerAvailable } from "@halinka/sandbox/devcontainer";

const run = promisify(execFile);

const checkTimeoutMs = 10_000;

const isOnPath = (command: string) =>
  run("sh", ["-c", 'command -v "$0"', command], { timeout: checkTimeoutMs }).then(
    () => true,
    () => false,
  );

type CapabilityOptions = {
  build: Build;
  canUpdate: boolean;
  sshHostKey: string;
  isDockerInContainer: boolean;
};

export const inspectCapabilities = async (
  sandboxKind: SandboxKind,
  { build, canUpdate, sshHostKey, isDockerInContainer }: CapabilityOptions,
): Promise<RunnerCapabilities> => {
  if (sandboxKind === "devcontainer") {
    const [hasDocker, hasSysbox] = await Promise.all([
      isDockerAvailable(),
      isDockerInContainer && hasSysboxRuntime(),
    ]);
    return { sandboxKind, build, canUpdate, hasDocker, hasSysbox, sshHostKey };
  }
  const presets = Object.values(agentPresets);
  const found = await Promise.all(presets.map(({ command }) => isOnPath(command[0]!)));
  return {
    sandboxKind,
    build,
    canUpdate,
    agentsOnPath: presets.filter((_, index) => found[index]).map(({ id }) => id),
  };
};

const hasDockerOf = (capabilities?: RunnerCapabilities) =>
  capabilities?.sandboxKind === "devcontainer" ? capabilities.hasDocker : undefined;

// Docker can start after the runner.
export const warnOnDockerChange = (
  before: RunnerCapabilities | undefined,
  after: RunnerCapabilities,
) => {
  const hasDocker = hasDockerOf(after);
  if (hasDocker === undefined || hasDocker === hasDockerOf(before)) return;
  if (!hasDocker)
    console.warn("Docker is not available. The runner takes no runs until Docker runs.");
  else if (before) console.log("Docker is available. The runner takes runs again.");
};
