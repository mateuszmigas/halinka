import type { Inputs, NetworkHosts, Workflow } from "@halinka/workflow";
import { z } from "zod";

import type { AgentAnswer, AgentQuestions } from "./agentQuestions";
import type { RunEvent } from "./runEvents";
import type { GitHubAccess, RepoPlace } from "./runnerCommands";
import type { RunnerUpdateRequest } from "./runnerStates";
import { type SandboxKind, type SandboxSpec, sandboxStates } from "./sandboxStates";

// The arguments of the `ControlPlane` methods are zod schemas, so the network transport checks them.
const idSchema = z.number().int();

export const runLeaseSchema = z.object({ workflowRunId: idSchema, lease: z.string() });
export type RunLease = z.infer<typeof runLeaseSchema>;

// A repeat with the same `callId` gives the first result, also after the lease ended.
export const runCallSchema = runLeaseSchema.extend({ callId: z.string().optional() });
export type RunCall = z.infer<typeof runCallSchema>;

export const runResults = ["succeeded", "failed", "cancelled"] as const;
export type RunResult = (typeof runResults)[number];

export const isRunResult = (status: string): status is RunResult =>
  runResults.some((result) => result === status);

// The runner keeps the lease of a run that waits for input.
export const leasedRunStatuses = ["running", "waiting_input"] as const;
export type LeasedRunStatus = (typeof leasedRunStatuses)[number];

export const isLeasedStatus = (status: string): status is LeasedRunStatus =>
  leasedRunStatuses.some((leased) => leased === status);

export const unleasedRunStatuses = ["queued", "expired"] as const;

export const isUnleasedStatus = (status: string) =>
  unleasedRunStatuses.some((unleased) => unleased === status);

export const endedOrExpiredStatuses = [...runResults, "expired"] as const;

export const isEndedOrExpired = (status: string) =>
  endedOrExpiredStatuses.some((settled) => settled === status);

export const runStatuses = ["queued", ...leasedRunStatuses, "expired", ...runResults] as const;
export type RunStatus = (typeof runStatuses)[number];

export const stepResults = ["succeeded", "failed", "cancelled"] as const;
export type StepResult = (typeof stepResults)[number];

// `skipped`: the `if` of the step was false
export const stepRunResults = [...stepResults, "skipped"] as const;

export const recordedStepStatuses = ["running", ...stepRunResults] as const;
export type RecordedStepStatus = (typeof recordedStepStatuses)[number];

// `superseded`: a reopen of an earlier step replaced it; the walk leaves it out
export const stepRunStatuses = [...recordedStepStatuses, "superseded"] as const;
export type StepRunStatus = (typeof stepRunStatuses)[number];

// JSON can write a character in 6 bytes, so the list fits in one message.
export const maxCheckpointChangedFilesLength = 1024 * 1024;

// The server keeps this many characters of a run error; the runner sends no more.
export const maxRunErrorLength = 8000;

const checkpointSchema = z.object({
  before: z.string(),
  after: z.string(),
  changedFiles: z.array(z.string()),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;

const usageSchema = z.object({
  // agent time of an agent attempt, command time of a shell attempt
  activeMs: z.number(),
  costUsd: z.number().optional(),
});
export type Usage = z.infer<typeof usageSchema>;

export const stepRunResultSchema = z.object({
  status: z.enum(stepRunResults),
  summary: z.string().optional(),
  outcome: z.string().optional(),
  outputs: z.record(z.string(), z.unknown()).optional(),
});
export type StepRunResult = z.infer<typeof stepRunResultSchema>;

// `stopped`: a limit stopped the agent; it does not use the attempt budget
export const attemptResults = ["succeeded", "failed", "stopped", "cancelled"] as const;
export const attemptResultSchema = stepRunResultSchema.extend({
  status: z.enum(attemptResults),
  exitCode: z.number().int().optional(),
  checkpoint: checkpointSchema.optional(),
  usage: usageSchema.optional(),
  sessionId: z.string().optional(),
  // the cost in `sessionId`, without a session that it replaced
  sessionCostUsd: z.number().nonnegative().optional(),
});
export type AttemptResult = z.infer<typeof attemptResultSchema>;

// `lost`: the process ended before the attempt did
export const attemptStatuses = ["running", ...attemptResults, "lost"] as const;
export type AttemptStatus = (typeof attemptStatuses)[number];

export type ClaimedRun = RepoPlace & {
  lease: RunLease;
  branch: string;
  // the first commit of the code
  baseSha: string;
  // the commit that gives the workflow, the devcontainer and the build
  definitionSha: string;
  pullRequestNumber?: number;
  // a runner gets only runs of its own kind
  sandboxKind: SandboxKind;
  // a path in the tree of `definitionSha`
  devcontainer?: string;
  setupNetwork?: NetworkHosts;
  // the run container gets Docker inside (Sysbox)
  setupDocker?: boolean;
  setupRun?: string;
  workflow: Workflow;
  inputs: Inputs;
  isUntrusted: boolean;
  isTestRun: boolean;
  // in the order the steps started
  steps: RecordedStep[];
  // the `after` of the last checkpoint, else `baseSha`; after a reopen, at least its `before`
  lastCheckpoint: string;
  rewind?: Rewind;
  // a person started the container since the last finished attempt
  isWorkspaceOpened?: boolean;
  // by preset: replaces the version of the preset
  agentVersions: Record<string, string>;
  // by preset: the default model
  agentModels: Record<string, string>;
};

// A reopen without a checkpoint.
export type Rewind = {
  stepRunId: number;
  // the commit before the step
  before: string;
  // the last commit of the step
  after: string;
  // no attempt yet
  isFresh: boolean;
  // a later step ran, so the workspace has its changes
  hasLaterAttempts: boolean;
};

// The step run that a reopen replaced.
export type ReopenedStep = {
  sessionId?: string;
  // the session cost before the reopen
  sessionCostUsd?: number;
  changedFiles?: string[];
  changedFileCount?: number;
} & Pick<StepRunResult, "summary" | "outputs">;

export type ToldToAgent =
  | Pick<AgentMessage, "author" | "text">
  | { questions: AgentQuestions; answer: AgentAnswer };

// The `ask_human` or `limit` item of the last attempt, with its report.
export type AttemptItem = { itemId: number; kind: AttemptItemKind } & Pick<
  StepRunResult,
  "summary" | "outcome" | "outputs"
>;

export const stepParentSchema = z.object({
  stepRunId: idSchema,
  // from 1
  iteration: idSchema,
});
export type StepParent = z.infer<typeof stepParentSchema>;

export type RecordedStep = {
  stepRunId: number;
  stepId: string;
  status: RecordedStepStatus;
  // the used attempt budget; only of a running step run
  failedAttempts: number;
  parent?: StepParent;
  // the sum of its attempts
  usage?: Usage;
  // the commit of the last attempt that has one
  commit?: string;
  // the session of the last attempt that has one
  sessionId?: string;
  // only of a running step run: the cost of the attempts of the run in `sessionId`
  sessionCostUsd?: number;
  // the union of its attempts, cut by `limitChangedFiles`
  changedFiles?: string[];
  changedFileCount?: number;
  // only of a running step run
  attemptItem?: AttemptItem;
  // only of a running step run that a reopen started
  reopened?: ReopenedStep;
  // only of a running step run, with the step runs that it reopened
  told?: ToldToAgent[];
} & Pick<StepRunResult, "summary" | "outcome" | "outputs">;

// The values of a step run that the server sums from its attempts
export type StepFacts = Pick<
  RecordedStep,
  "usage" | "commit" | "sessionId" | "changedFiles" | "changedFileCount"
>;

// One line of a known hosts file comes from this value: it must hold nothing else.
const sshHostKeyPattern = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/;

export const isSshHostKey = (value: string) => sshHostKeyPattern.test(value);

// Change it when a runner and a server of different versions cannot work together.
export const protocolVersion = 20;

export const unsupportedVersionReason = (version: number) =>
  `The server uses protocol version ${protocolVersion}, not ${version}`;

// `id` identifies the code: two builds of one version can differ
export const buildSchema = z.object({
  version: z.string().min(1).max(64),
  id: z.string().min(1).max(128),
});
export type Build = z.infer<typeof buildSchema>;

const capabilitiesBaseSchema = z.object({
  build: buildSchema,
  // runs under its service unit with self-update on, so it can restart into another build
  canUpdate: z.boolean(),
});

// `sandboxKind`: the sandbox that the runner makes for a claimed run
export const runnerCapabilitiesSchema = z.discriminatedUnion("sandboxKind", [
  capabilitiesBaseSchema.extend({
    sandboxKind: z.literal("devcontainer"),
    // the Docker daemon answers
    hasDocker: z.boolean(),
    // Docker lists `sysbox-runc`, and the runner flag allows it
    hasSysbox: z.boolean(),
    sshHostKey: z.string().regex(sshHostKeyPattern),
  }),
  capabilitiesBaseSchema.extend({
    sandboxKind: z.literal("worktree"),
    agentsOnPath: z.array(z.string()),
  }),
]);
export type RunnerCapabilities = z.infer<typeof runnerCapabilitiesSchema>;

export const syncRequestSchema = z.object({
  // the leases of the running engines of the process
  held: z.array(runLeaseSchema),
  // free run slots
  capacity: z.number().int().nonnegative(),
  capabilities: runnerCapabilitiesSchema,
  // list every sandbox, also the applied ones
  isSweep: z.boolean().optional(),
  // the process runs no agent test
  canTest: z.boolean().optional(),
});
export type SyncRequest = z.infer<typeof syncRequestSchema>;

export type RunBranch = { name: string; lastCheckpoint: string };

export type SandboxTarget = RepoPlace & {
  workflowRunId: number;
  // the sandbox that the claim made
  kind: SandboxKind;
  baseSha: string;
  definitionSha: string;
  devcontainer?: string;
  setupNetwork?: NetworkHosts;
  setupDocker?: boolean;
  spec: SandboxSpec;
  // a new spec gets a greater generation
  generation: number;
  // of a deleted run; a checkout deletes it only when another ref holds its tip
  runBranch?: RunBranch;
};

export const sandboxAttachSchema = z.object({
  containerName: z.string(),
  containerFolder: z.string(),
});
export type SandboxAttach = z.infer<typeof sandboxAttachSchema>;

// `attach`: only when `observed` is `running`
export const sandboxObservationSchema = z.object({
  observed: z.enum(sandboxStates),
  attach: sandboxAttachSchema.optional(),
});
export type SandboxObservation = z.infer<typeof sandboxObservationSchema>;

// A failure leaves the generation unapplied, so the next `sync` lists it again.
export const sandboxReportSchema = z.intersection(
  z.object({ workflowRunId: idSchema, generation: idSchema }),
  z.union([sandboxObservationSchema, z.object({ error: z.string() })]),
);
export type SandboxReport = z.infer<typeof sandboxReportSchema>;

export type SyncResult = {
  // the ids in `held` that the server still wants executed
  keep: number[];
  claimed: ClaimedRun[];
  // the decided items of the kept and claimed runs that the engine has not taken yet
  answers: InboxAnswer[];
  // the undelivered messages of the kept and claimed runs whose step runs still run
  messages: AgentMessage[];
  // of the runs of the runner without a lease
  sandboxes: SandboxTarget[];
  agentTest?: ClaimedAgentTest;
  // the server wants the process to restart into its build
  update?: RunnerUpdateRequest;
};

export const agentTestStatuses = ["requested", "running", "passed", "failed"] as const;

export type ClaimedAgentTest = {
  token: string;
  preset: string;
  // replaces the version of the preset
  version?: string;
  // the default model
  model?: string;
};

export const agentTestResultSchema = z.union([
  z.object({ capabilities: z.record(z.string(), z.unknown()) }),
  z.object({ error: z.string() }),
]);
export type AgentTestResult = z.infer<typeof agentTestResultSchema>;

// The kinds of item that finish their attempt: `askHuman` opens them
export const attemptItemKinds = ["ask_human", "limit"] as const;
export type AttemptItemKind = (typeof attemptItemKinds)[number];

export const isAttemptItemKind = (kind: string): kind is AttemptItemKind =>
  attemptItemKinds.some((attemptKind) => attemptKind === kind);

export const decisionItemKinds = ["approval", ...attemptItemKinds] as const;
export type DecisionItemKind = (typeof decisionItemKinds)[number];

// `question`: from the `ask_human` tool; the attempt keeps running
export const inboxItemKinds = [...decisionItemKinds, "question"] as const;
export type InboxItemKind = (typeof inboxItemKinds)[number];

export const approvalDecisions = ["approve", "reject"] as const;

export const gateDecisions = ["retry", "accept", "fail"] as const;

export const limitDecisions = ["continue", "fail"] as const;

export const decisionItemDecisions = [...approvalDecisions, ...gateDecisions, "continue"] as const;
export type DecisionItemDecision = (typeof decisionItemDecisions)[number];

// `answered`: the server stores it when a person answers a question item
export const inboxItemDecisions = [...decisionItemDecisions, "answered"] as const;
export type InboxItemDecision = (typeof inboxItemDecisions)[number];

export const kindDecisions = {
  approval: approvalDecisions,
  ask_human: gateDecisions,
  limit: limitDecisions,
  question: ["answered"],
} as const satisfies Record<InboxItemKind, readonly InboxItemDecision[]>;

// The decision of a pending item when a message to its step arrives
export const proceedDecisions = {
  ask_human: "retry",
  limit: "continue",
} as const satisfies Record<AttemptItemKind, DecisionItemDecision>;

export const isDecisionOf = <K extends InboxItemKind>(
  kind: K,
  decision: InboxItemDecision,
): decision is (typeof kindDecisions)[K][number] =>
  kindDecisions[kind].some((allowed) => allowed === decision);

export type InboxAnswer = {
  workflowRunId: number;
  itemId: number;
  decision: InboxItemDecision;
  note?: string;
  // only on a `question` item
  answer?: AgentAnswer;
  resolvedBy: string;
};

// The server marks it delivered when it stores the `agent_prompt` event that lists it.
export type AgentMessage = {
  workflowRunId: number;
  messageId: number;
  stepRunId: number;
  text: string;
  author: string;
};

export type StartedAttempt = { attemptId: number; attempt: number };

// Send one batch at a time, again until acknowledged, before `finishRun`; never after `lease_lost`.
export type EventBatch = {
  // the server stores a batch id once
  batchId: string;
  events: RunEvent[];
};

// JSON bytes. The runner refuses a larger message, so the server never closes a connection for size.
export const maxMessageBytes = 16 * 1024 * 1024;
export const maxBatchBytes = 1024 * 1024;
export const maxEventBytes = 4 * 1024 * 1024;

const maxChangedFileNames = 1000;
const maxChangedFileNamesLength = 64 * 1024;

// All steps of all claimed runs go in one `sync` message. `count`: also the names past the limit.
export const limitChangedFiles = (files: string[], count = files.length) => {
  const changedFiles: string[] = [];
  let length = 0;
  for (const file of files.toSorted()) {
    length += file.length;
    if (changedFiles.length === maxChangedFileNames || length > maxChangedFileNamesLength) break;
    changedFiles.push(file);
  }
  return { changedFiles, changedFileCount: count };
};

export type StoredCredential = { variable: string; value: string };

// `missing`: the names without a value that the server can read
export type SetupSecrets = { values: StoredCredential[]; missing: string[] };

const commitIdSchema = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

export type PushAccess = {
  // the last checkpoint of the run
  commit: string;
  // none: the `gh` login of the runner pushes
  github?: GitHubAccess | undefined;
  // the lease of the branch; undefined: the server stores no push of it
  pushedCommit?: string;
};

// `url`: the comment of this step run, so a repeat posts nothing
export type CommentAccess = { url: string } | { pullRequestNumber: number; github: GitHubAccess };

export const pushedBranchWriteSchema = z.object({
  // the `pushedCommit` of `readPushAccess`
  expected: commitIdSchema.optional(),
  // unset keeps the stored one
  pullRequestUrl: z
    .string()
    .regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/)
    .optional(),
});
export type PushedBranchWrite = z.infer<typeof pushedBranchWriteSchema>;

// `stepResult` also finishes the attempt's step run, in the same transaction
export type FinishAttemptOptions = { result: AttemptResult; stepResult?: StepRunResult };
export type AskHumanOptions = { result: AttemptResult; kind: AttemptItemKind; message: string };

// The only way a runner reads and changes run state; a run call without a valid lease is refused.
export type ControlPlane = {
  // renews `held`; an unlisted or expired run of the process is queued again, or cancelled at a request
  sync: (request: SyncRequest) => Promise<SyncResult>;
  startStep: (lease: RunCall, stepId: string, parent?: StepParent) => Promise<number>;
  // finishStep and startAttempt: the running attempts of the step run become `lost`
  finishStep: (lease: RunCall, stepRunId: number, result: StepRunResult) => Promise<StepFacts>;
  startAttempt: (lease: RunCall, stepRunId: number) => Promise<StartedAttempt>;
  finishAttempt: (
    lease: RunCall,
    attemptId: number,
    options: FinishAttemptOptions,
  ) => Promise<StepFacts>;
  appendEvents: (lease: RunLease, batch: EventBatch) => Promise<void>;
  // one item per step run; the run waits for input until a person decides
  openApproval: (lease: RunCall, stepRunId: number, message: string) => Promise<number>;
  // in one transaction: finishes the attempt, opens an item of `kind`, and the run waits for input
  askHuman: (lease: RunCall, attemptId: number, options: AskHumanOptions) => Promise<number>;
  // the run waits for input; the attempt keeps running
  askQuestion: (lease: RunCall, attemptId: number, questions: AgentQuestions) => Promise<number>;
  // only for a branch the runner created; a branch that existed before stays the user's
  branchCreated: (lease: RunCall) => Promise<void>;
  // running step runs and attempts end with it; refuses `succeeded` while one runs
  finishRun: (lease: RunCall, result: RunResult, error?: string) => Promise<void>;
  // only for a run in a container; empty: the runner uses its own
  readAgentCredentials: (lease: RunLease, preset: string) => Promise<StoredCredential[]>;
  // only for a run in a container
  readSetupSecrets: (lease: RunLease) => Promise<SetupSecrets>;
  // only for a run of a `github` repo: a read token for that repo
  readMirrorAccess: (lease: RunLease) => Promise<GitHubAccess>;
  // only for a running step of a run with changes, and reviews of its last checkpoint
  readPushAccess: (lease: RunLease, stepRunId: number) => Promise<PushAccess>;
  // stores the last checkpoint; refuses a write when the stored commit is not `expected`
  storePushedBranch: (lease: RunCall, stepRunId: number, write: PushedBranchWrite) => Promise<void>;
  readCommentAccess: (lease: RunLease, stepRunId: number) => Promise<CommentAccess>;
  storeComment: (lease: RunCall, stepRunId: number, url: string) => Promise<void>;
  // only for a running test in a container
  readTestCredentials: (token: string) => Promise<StoredCredential[]>;
  // the server ignores the result of a replaced test
  finishAgentTest: (token: string, result: AgentTestResult) => Promise<void>;
  // the server ignores a report of an older generation
  reportSandbox: (report: SandboxReport) => Promise<void>;
};
