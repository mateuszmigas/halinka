import {
  type AttemptItem,
  type AttemptResult,
  type InboxItemKind,
  isDecisionOf,
  type RecordedStep,
  type RunEvent,
  type StartedAttempt,
  type StepFacts,
  type StepRunResult,
} from "@halinka/protocol";
import { errorMessage } from "@halinka/utils/errors";

import type { StepLimit } from "./limits";
import { continuePrompt } from "./prompts";
import type { RunInbox, StepContext } from "./runDeps";

// Gate failures with no failed `on_fail: fail` gate
export type GateFailure = { prompt: string; message: string; isHumanDecisionRequired: boolean };

type AttemptOutcome = Omit<
  Extract<RunEvent, { kind: "attempt_finished" }>["payload"],
  "stepId" | "attemptId"
>;

export type AttemptBodyResult = AttemptOutcome &
  Pick<
    AttemptResult,
    "outcome" | "outputs" | "checkpoint" | "usage" | "sessionId" | "sessionCostUsd"
  > & {
    gateFailure?: GateFailure;
    limitStop?: { message: string; limit: StepLimit };
  };

// `prompt`: unset after a resume, because the server does not store the gate feedback
export type Retry = { prompt?: string; raise?: StepLimit };

type AttemptBody = (
  attempt: StartedAttempt,
  signal: AbortSignal,
  retry: Retry | undefined,
) => Promise<AttemptBodyResult>;

export type AttemptPolicy = { maxAttempts: number; onExhausted: "ask_human" | "fail" };

export const singleAttempt: AttemptPolicy = { maxAttempts: 1, onExhausted: "fail" };

export type StepRun = Pick<
  RecordedStep,
  | "stepRunId"
  | "failedAttempts"
  | "attemptItem"
  | "reopened"
  | "usage"
  | "sessionId"
  | "sessionCostUsd"
  | "changedFiles"
  | "told"
>;

export type StepOutcome = StepRunResult & StepFacts;

type PendingItem = AttemptItem & Pick<Retry, "prompt">;

type StartingPoint = {
  stepId: string;
  attempt: number;
  isInterrupted: boolean;
  isReopenStart?: boolean;
  isWritable: boolean;
};

type AttemptCommit = StartedAttempt & { stepId: string; before: string; summary?: string };

const exhaustedMessage = (maxAttempts: number, message: string) =>
  `The attempt budget of ${maxAttempts} is used up. ${message}`;

export const withNote = (summary: string | undefined, decided: string, note?: string) =>
  [summary, note ? `${decided}: ${note}` : decided].filter(Boolean).join("\n\n");

type WaitForDecisionOptions<K extends InboxItemKind> = { kind: K; itemId: number };

export const waitForDecision = async <K extends InboxItemKind>(
  inbox: RunInbox,
  { kind, itemId }: WaitForDecisionOptions<K>,
  signal: AbortSignal,
) => {
  const delivered = await inbox.waitForDecision(itemId, signal);
  const { decision } = delivered;
  if (!isDecisionOf(kind, decision)) {
    throw new Error(`Inbox item ${itemId} got the decision "${decision}"`);
  }
  return { ...delivered, decision };
};

export const runAttempts = async (
  context: StepContext,
  { stepId, stepRun, policy }: { stepId: string; stepRun: StepRun; policy: AttemptPolicy },
  body: AttemptBody,
): Promise<StepOutcome | "aborted"> => {
  const {
    deps: { plane, inbox },
    lease,
    events,
    signal,
  } = context;
  const { stepRunId, failedAttempts, attemptItem } = stepRun;
  const { maxAttempts, onExhausted } = policy;
  const attemptSignal = AbortSignal.any([signal, events.stopped]);
  const decide = async ({
    itemId,
    kind,
    prompt,
    ...report
  }: PendingItem): Promise<Retry | StepOutcome | "aborted"> => {
    let answer;
    try {
      answer = await waitForDecision(inbox, { kind, itemId }, attemptSignal);
    } catch (error) {
      if (signal.aborted) return "aborted";
      attemptSignal.throwIfAborted();
      throw error;
    }
    const { decision, note } = answer;
    if (decision === "retry" || decision === "continue") return { prompt };
    const [status, decided] =
      decision === "accept"
        ? (["succeeded", "Accepted with failed gates"] as const)
        : (["failed", "Failed"] as const);
    const stepResult = { ...report, status, summary: withNote(report.summary, decided, note) };
    return { ...stepResult, ...(await plane.finishStep(lease, stepRunId, stepResult)) };
  };
  let failed = failedAttempts;
  let retry: Retry | undefined;
  if (attemptItem) {
    const decided = await decide(attemptItem);
    if (decided === "aborted" || "status" in decided) return decided;
    retry = decided;
  }
  for (;;) {
    if (signal.aborted) return "aborted";
    const started = await plane.startAttempt(lease, stepRunId);
    const { attemptId, attempt } = started;
    events.emit({ kind: "attempt_started", payload: { stepId, stepRunId, attemptId, attempt } });
    const result = await body(started, attemptSignal, retry).catch((error): AttemptBodyResult => ({
      status: "failed",
      error: errorMessage(error),
    }));
    // An agent returns normally on cancel.
    if (signal.aborted) return "aborted";
    const {
      outcome,
      outputs,
      checkpoint,
      usage,
      sessionId,
      sessionCostUsd,
      gateFailure,
      limitStop,
      ...finished
    } = result;
    events.emit({ kind: "attempt_finished", payload: { stepId, attemptId, ...finished } });
    await events.flushBefore(signal);
    const { status, exitCode, summary, error } = finished;
    if (status === "failed") failed++;
    const report = { summary: summary ?? error, outcome, outputs };
    const attemptResult = {
      status,
      exitCode,
      checkpoint,
      usage,
      sessionId,
      sessionCostUsd,
      ...report,
    };
    const finishStep = async () => {
      const stepResult = { status: status === "stopped" ? "failed" : status, ...report } as const;
      return {
        ...stepResult,
        ...(await plane.finishAttempt(lease, attemptId, { result: attemptResult, stepResult })),
      };
    };
    const ask = async (kind: AttemptItem["kind"], message: string, prompt?: string) => {
      const itemId = await plane.askHuman(lease, attemptId, {
        result: attemptResult,
        kind,
        message,
      });
      return decide({ itemId, kind, prompt, ...report });
    };
    let decided;
    let raise: StepLimit | undefined;
    if (limitStop) {
      if (onExhausted === "fail") return finishStep();
      decided = await ask("limit", limitStop.message, continuePrompt);
      raise = limitStop.limit;
    } else {
      if (!gateFailure) return finishStep();
      const { prompt, message, isHumanDecisionRequired } = gateFailure;
      if (!isHumanDecisionRequired && failed < maxAttempts) {
        await plane.finishAttempt(lease, attemptId, { result: attemptResult });
        retry = { prompt };
        continue;
      }
      if (!isHumanDecisionRequired && onExhausted === "fail") return finishStep();
      const asked = isHumanDecisionRequired ? message : exhaustedMessage(maxAttempts, message);
      decided = await ask("ask_human", asked, prompt);
    }
    if (decided === "aborted" || "status" in decided) return decided;
    retry = { ...decided, raise };
  }
};

// Earlier changes stay in the step only at a reopen, or after an interrupt in an unopened workspace.
export const startingPoint = async (
  { checkpoints, deps, isWorkspaceOpened }: StepContext,
  { stepId, attempt, isInterrupted, isReopenStart = false, isWritable }: StartingPoint,
) => {
  const head = await checkpoints.readHead();
  const isKept = isReopenStart || (isInterrupted && !isWorkspaceOpened);
  if (!isKept || (!isWritable && isWorkspaceOpened)) {
    const committed = await checkpoints.commitChangesBefore(head, stepId, attempt);
    if (committed) await deps.repoSource.publish(committed);
    return committed ?? head;
  }
  if (!isWritable) await checkpoints.discard(head);
  return head;
};

export const commitAttempt = async (
  { checkpoints, events, deps }: StepContext,
  { stepId, attemptId, attempt, before, summary }: AttemptCommit,
) => {
  const checkpoint = await checkpoints.commit(before, { stepId, attempt, summary });
  if (checkpoint.after !== before) await deps.repoSource.publish(checkpoint.after);
  events.emit({
    kind: "checkpoint",
    payload: { stepId, attemptId, before, after: checkpoint.after },
  });
  return checkpoint;
};
