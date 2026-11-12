import type { AgentEvent } from "@halinka/agents";
import type { ClaimedRun, RecordedStep } from "@halinka/protocol";
import { leaseOf } from "@halinka/protocol/testing";
import type { AgentStep, LeafStep, LoopStep, Step } from "@halinka/workflow";

export type Gate = NonNullable<AgentStep["gates"]>[number];

// The prompt of a step for the fake agent is its script.
export const agentStep = (fields: Partial<AgentStep> = {}): AgentStep => ({
  id: "a1",
  type: "agent",
  agent: "fake",
  prompt: "Fix the bug",
  ...fields,
});

export const loopStep = (steps: LeafStep[], fields: Partial<LoopStep> = {}): LoopStep => ({
  id: "fix_loop",
  type: "loop",
  max_iterations: 2,
  until: "${{ loop.iteration == 2 }}",
  steps,
  ...fields,
});

export const readOnly = (fields: Partial<AgentStep> = {}): AgentStep =>
  agentStep({ prompt: "review the code", permissions: { write: false }, ...fields });

export const approvalStep: LeafStep = {
  id: "approve",
  type: "approval",
  message: "Check the diff",
};

export const replayStep = (updates: AgentEvent[]) =>
  agentStep({ prompt: JSON.stringify(updates), agent: "replay" });

export const buildStep: LeafStep = { id: "build", type: "shell", run: "build" };

export const budgeted = (run: ClaimedRun, max_cost_usd: number): ClaimedRun => ({
  ...run,
  workflow: { ...run.workflow, max_cost_usd },
});

// A string is a shell step whose command is the script of the fake sandbox.
export const claimedRun = (scripts: (string | Step)[], steps: RecordedStep[] = []): ClaimedRun => ({
  lease: leaseOf(1),
  repoPath: "/code/app",
  branch: "halinka/run-1",
  baseSha: "abc",
  definitionSha: "abc",
  sandboxKind: "worktree",
  agentVersions: {},
  agentModels: {},
  workflow: {
    name: "Test",
    steps: scripts.map((run, index) =>
      typeof run === "string" ? { id: `s${index + 1}`, type: "shell", run } : run,
    ),
  },
  inputs: {},
  isUntrusted: false,
  isTestRun: false,
  steps,
  lastCheckpoint: "sha-0",
});
