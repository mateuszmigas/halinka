import { leasedRunStatuses } from "@halinka/protocol";
import { inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { agents, runners, workflowRuns, workflowSnapshots } from "../schema";

// `draining` and `updating` are last: `runs.create` refuses only the codes before them.
export type SettingsRefusalCode =
  | "revoked"
  | "labels"
  | "agents"
  | "agent_disabled"
  | "draining"
  | "updating";

// A run of a runner that takes no new runs for a while waits in the queue.
export const isPassingRefusal = (code: SettingsRefusalCode) =>
  code === "draining" || code === "updating";

export type CapabilityRefusalCode =
  | "untrusted"
  | "test_run"
  | "sandbox_kind"
  | "docker"
  | "devcontainer_file"
  | "setup_secrets"
  | "sysbox"
  | "agents_on_path";

export const isSandboxRemoved = sql`(${workflowRuns.sandbox} = 'destroyed' and ${workflowRuns.sandboxObservedGeneration} is not distinct from ${workflowRuns.sandboxGeneration})`;

// Use the fragments below in a query with a join, so drizzle names the table of each column.
export const hasWorkspace = sql`(${workflowRuns.sandbox} is not null and not ${isSandboxRemoved})`;

export const disabledAgents = sql<
  string[]
>`array(select ${agents.preset} from ${agents} where ${agents.preset} = any(${workflowSnapshots.agents}) and not ${agents.enabled})`;

export const settingsRefusal = sql<SettingsRefusalCode | null>`case
  when ${runners.state} = 'revoked' then 'revoked'
  when not ${workflowSnapshots.runsOn} <@ ${runners.labels} then 'labels'
  when ${runners.allowedAgents} is not null and not ${workflowSnapshots.agents} <@ ${runners.allowedAgents} then 'agents'
  when exists (select 1 from ${agents} where ${agents.preset} = any(${workflowSnapshots.agents}) and not ${agents.enabled}) then 'agent_disabled'
  when ${runners.state} = 'draining' then 'draining'
  when ${runners.updateRequest} is not null then 'updating'
end`;

export const capabilityRefusal = sql<CapabilityRefusalCode | null>`case
  when ${runners.sandboxKind} = 'worktree' and ${workflowRuns.untrusted} then 'untrusted'
  when ${runners.sandboxKind} = 'worktree' and ${workflowRuns.testRun} then 'test_run'
  when ${hasWorkspace} and ${workflowRuns.sandboxKind} <> ${runners.sandboxKind} then 'sandbox_kind'
  when ${runners.sandboxKind} = 'devcontainer' and not ${runners.docker} then 'docker'
  when ${runners.sandboxKind} = 'devcontainer' and ${workflowSnapshots.devcontainer} is null then 'devcontainer_file'
  when ${runners.sandboxKind} = 'worktree' and cardinality(${workflowSnapshots.setupSecrets}) > 0 then 'setup_secrets'
  when ${runners.sandboxKind} = 'devcontainer' and ${workflowSnapshots.setupDocker} and not ${runners.sysbox} then 'sysbox'
  when ${runners.sandboxKind} = 'worktree' and not ${workflowSnapshots.agents} <@ ${runners.agentsOnPath} then 'agents_on_path'
end`;

const otherRun = alias(workflowRuns, "other_run");

// A claim also calls `WorkflowRunRepository.holdsGroup`: a reopen can queue a lower run meanwhile.
export const isFirstOfGroup = sql`(${workflowRuns.concurrencyGroup} is null or not exists (
  select 1 from ${workflowRuns} as other_run
  where ${otherRun.repoId} = ${workflowRuns.repoId}
    and ${otherRun.concurrencyGroup} = ${workflowRuns.concurrencyGroup}
    and ${otherRun.id} <> ${workflowRuns.id}
    and (${inArray(otherRun.status, [...leasedRunStatuses])}
      or (${otherRun.status} = 'queued' and ${otherRun.id} < ${workflowRuns.id}))))`;

// Use it in a query of `workflow_runs` that joins `workflow_snapshots`.
export const canTakeAny = (runnerIds: number[]) =>
  sql`exists (select 1 from ${runners} where ${inArray(runners.id, runnerIds)} and ${settingsRefusal} is null and ${capabilityRefusal} is null)`;

export const canTake = (runnerId: number) => canTakeAny([runnerId]);
