import { isLeasedStatus, leasedRunStatuses } from "@halinka/protocol";
import { repoConfigPath } from "@halinka/workflow";

import { type ConnectedRunners, isConnected } from "./connectedRunners";
import type {
  CapabilityRefusalCode,
  Repositories,
  SettingsRefusalCode,
  WorkflowRunRepository,
} from "./db/repositories";
import type { DbRunner, DbWorkflowRun } from "./db/schema";

type WaitFacts = NonNullable<Awaited<ReturnType<WorkflowRunRepository["findWaitFacts"]>>>;

type NoRunnerWaitFacts = NonNullable<
  Awaited<ReturnType<WorkflowRunRepository["findWaitFactsWithNoRunner"]>>
>;

type RunnerWaitReasonOptions = { isRunnerConnected: boolean };

export const disabledAgentReason = (agents: string[]) =>
  `The agent ${agents.join(", ")} is disabled. An Admin can enable it on the Agents page`;

export const settingsRefusalReason = ({
  refusal,
  name,
  labels,
  allowedAgents,
  runsOn,
  agents,
  disabledAgents,
}: Pick<DbRunner, "name" | "labels" | "allowedAgents"> & {
  refusal: SettingsRefusalCode;
  runsOn: string[];
  agents: string[];
  disabledAgents: string[];
}) => {
  if (refusal === "revoked") return `The runner ${name} is revoked`;
  if (refusal === "draining") return `The runner ${name} drains: it takes no new runs`;
  if (refusal === "updating") {
    return `The runner ${name} waits for its update: it takes no new runs until it starts again`;
  }
  if (refusal === "agent_disabled") return disabledAgentReason(disabledAgents);
  if (refusal === "labels") {
    const missing = runsOn.filter((label) => !labels.includes(label));
    return `The runner ${name} has no label ${missing.join(", ")}. Add the label to the runner, or change runs-on`;
  }
  const refused = agents.filter((agent) => !allowedAgents?.includes(agent));
  return `The runner ${name} does not allow the agent ${refused.join(", ")}`;
};

const capabilityRefusalReason = (
  refusal: CapabilityRefusalCode,
  { name, agentsOnPath, runnerSandboxKind, runSandboxKind, agents }: WaitFacts,
) => {
  if (refusal === "untrusted") {
    return `The run comes from GitHub or a schedule, and the runner ${name} runs workflows in a worktree. The run needs a container`;
  }
  if (refusal === "test_run") {
    return `The run is a test of a draft, and the runner ${name} runs workflows in a worktree. The run needs a container`;
  }
  if (refusal === "sandbox_kind") {
    return `The run keeps a workspace in a ${runSandboxKind}, and the runner ${name} runs workflows in a ${runnerSandboxKind}. Remove the workspace of the run`;
  }
  if (refusal === "docker") return `Docker is not available on the runner ${name}`;
  if (refusal === "devcontainer_file") {
    return `The runner ${name} runs workflows in a devcontainer, and the repo has no devcontainer in ${repoConfigPath}`;
  }
  if (refusal === "setup_secrets") {
    return `The runner ${name} runs workflows in a worktree, and only a container gets the secrets of setup`;
  }
  if (refusal === "sysbox") {
    return `The repo asks for Docker in the container, and the runner ${name} has no Sysbox. Start the runner with --docker-in-container on a Linux host with Sysbox`;
  }
  const missing = agents.filter((agent) => !agentsOnPath.includes(agent));
  return `The runner ${name} has no command of the agent ${missing.join(", ")} on PATH`;
};

// Check the connection first: the capabilities can be old, and a runner that never synced has none.
const runnerWaitReason = (facts: WaitFacts, { isRunnerConnected }: RunnerWaitReasonOptions) => {
  if (facts.settingsRefusal) {
    return settingsRefusalReason({ ...facts, refusal: facts.settingsRefusal });
  }
  if (!isRunnerConnected) return `The runner ${facts.name} is not connected`;
  if (facts.capabilityRefusal) return capabilityRefusalReason(facts.capabilityRefusal, facts);
  return undefined;
};

const noRunnerWaitReason = ({
  canBeTaken,
  disabledAgents,
  runsOn,
  agents,
  untrusted,
  testRun,
}: NoRunnerWaitFacts) => {
  if (canBeTaken) return undefined;
  if (disabledAgents.length > 0) return disabledAgentReason(disabledAgents);
  const needs = [
    ...(untrusted || testRun ? ["a runner with containers"] : []),
    ...(runsOn.length > 0 ? [`the labels ${runsOn.join(", ")}`] : []),
    ...(agents.length > 0 ? [`the agents ${agents.join(", ")}`] : []),
  ];
  const text = "No connected runner can take the run";
  return needs.length > 0 ? `${text}. It needs ${needs.join(" and ")}` : text;
};

const findRunnerWaitReason = async (
  { workflowRun }: Repositories,
  connectedRunners: ConnectedRunners,
  { id, runnerId }: DbWorkflowRun,
) => {
  if (runnerId === null) {
    const facts = await workflowRun.findWaitFactsWithNoRunner(id, connectedRunners.listIds());
    return facts && noRunnerWaitReason(facts);
  }
  const facts = await workflowRun.findWaitFacts(id);
  return (
    facts &&
    runnerWaitReason(facts, {
      isRunnerConnected: isConnected(connectedRunners, facts.runnerId),
    })
  );
};

const findGroupWaitReason = async (
  { workflowRun }: Repositories,
  { id, repoId, concurrencyGroup }: DbWorkflowRun,
) => {
  if (concurrencyGroup === null) return undefined;
  const runs = await workflowRun.listInGroup(repoId, concurrencyGroup, [
    "queued",
    ...leasedRunStatuses,
  ]);
  const holder = runs.find(({ status }) => isLeasedStatus(status)) ?? runs[0];
  return !holder || holder.id === id
    ? undefined
    : `The run ${holder.id} of the concurrency group ${concurrencyGroup} goes first`;
};

// Why a queued run waits; undefined when a runner can take it.
export const findWaitReason = async (
  repositories: Repositories,
  connectedRunners: ConnectedRunners,
  run: DbWorkflowRun,
) =>
  (await findRunnerWaitReason(repositories, connectedRunners, run)) ??
  (await findGroupWaitReason(repositories, run));
