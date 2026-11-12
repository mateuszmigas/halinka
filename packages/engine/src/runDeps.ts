import type { Agent } from "@halinka/agents";
import type {
  AgentMessage,
  ClaimedRun,
  ControlPlane,
  InboxAnswer,
  PullRequestAnswer,
  RunLease,
} from "@halinka/protocol";
import type { Sandbox } from "@halinka/sandbox";

import type { Checkpoints, LentValues } from "./checkpoints";
import type { EventLog } from "./eventLog";

export type InboxDecision = Pick<InboxAnswer, "decision" | "note" | "answer" | "resolvedBy">;

export type RunInbox = {
  waitForDecision: (itemId: number, signal: AbortSignal) => Promise<InboxDecision>;
  takeMessages: (stepRunId: number) => AgentMessage[];
  // settles at once while the step run has a message to take
  messageArrived: (stepRunId: number, signal: AbortSignal) => Promise<void>;
};

export type RunPullRequest = { stepRunId: number; title: string; body: string };
export type RunComment = { stepRunId: number; stepId: string; body: string };

// `publish` runs before the server stores the checkpoint.
export type RepoSource = {
  publish: (commit: string) => Promise<void>;
  openPullRequest: (request: RunPullRequest, signal: AbortSignal) => Promise<PullRequestAnswer>;
  commentOnPullRequest: (
    request: RunComment,
    signal: AbortSignal,
  ) => Promise<{ url: string } | { error: string }>;
};

export type RunDeps = {
  plane: ControlPlane;
  sandbox: Sandbox;
  repoSource: RepoSource;
  agents: ReadonlyMap<string, Agent>;
  inbox: RunInbox;
  lent: LentValues;
  // of a run on a pull request: where its changes start
  reviewBase?: string;
};

export type AsData = (text: string) => string;

export type StepContext = {
  deps: RunDeps;
  lease: RunLease;
  checkpoints: Checkpoints;
  events: EventLog;
  signal: AbortSignal;
  isWorkspaceOpened: boolean;
  agentModels: ClaimedRun["agentModels"];
  asData: AsData;
  workflowName: string;
};
