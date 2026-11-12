import {
  type AskHumanOptions,
  type AttemptResult,
  type ControlPlane,
  type EventBatch,
  type FinishAttemptOptions,
  limitChangedFiles,
  type StepFacts,
  type StepParent,
  type StepRunResult,
} from "@halinka/protocol";

type Questions = Parameters<ControlPlane["askQuestion"]>[2];

const sumOf = (values: number[]) => values.reduce((sum, value) => sum + value, 0);

export class FakeControlPlane implements ControlPlane {
  readonly calls: string[] = [];
  readonly finished: FinishAttemptOptions[] = [];
  readonly finishedSteps: StepRunResult[] = [];
  private readonly batches: EventBatch[] = [];
  private readonly attempts = new Map<number, number>();
  private readonly stepRunOfAttempt = new Map<number, number>();
  private readonly results = new Map<number, AttemptResult[]>();
  private nextId = 10;
  private nextItemId = 20;

  constructor(overrides: Partial<ControlPlane> = {}) {
    Object.assign(this, overrides);
  }

  events() {
    return this.batches.flatMap((batch) => batch.events);
  }

  eventKinds() {
    return this.events().map(({ kind }) => kind);
  }

  lastEvent() {
    return this.events().at(-1);
  }

  agentUpdates() {
    return this.events().flatMap(({ kind, payload }) =>
      kind === "agent_update" ? [payload.update] : [],
    );
  }

  prompts() {
    return this.events().flatMap(({ kind, payload }) =>
      kind === "agent_prompt" ? [payload.text] : [],
    );
  }

  async sync() {
    return { keep: [], claimed: [], answers: [], messages: [], sandboxes: [] };
  }

  async startStep(_: unknown, stepId: string, parent?: StepParent) {
    this.calls.push(
      `startStep ${stepId}${parent ? ` in ${parent.stepRunId}.${parent.iteration}` : ""}`,
    );
    return this.nextId++;
  }

  async finishStep(_: unknown, stepRunId: number, result: StepRunResult) {
    this.finishedSteps.push(result);
    this.calls.push(`finishStep ${stepRunId} ${result.status}`);
    return this.factsOf(stepRunId);
  }

  async startAttempt(_: unknown, stepRunId: number) {
    this.calls.push(`startAttempt ${stepRunId}`);
    const attempt = (this.attempts.get(stepRunId) ?? 0) + 1;
    this.attempts.set(stepRunId, attempt);
    this.stepRunOfAttempt.set(this.nextId, stepRunId);
    return { attemptId: this.nextId++, attempt };
  }

  async finishAttempt(_: unknown, attemptId: number, { result, stepResult }: FinishAttemptOptions) {
    this.finished.push({ result, stepResult });
    const { status, exitCode } = result;
    this.calls.push(`finishAttempt ${attemptId} ${status} ${exitCode} ${stepResult?.status}`);
    return this.factsOf(this.store(attemptId, result));
  }

  async appendEvents(_: unknown, batch: EventBatch) {
    this.batches.push(batch);
  }

  async openApproval(_: unknown, stepRunId: number, message: string) {
    this.calls.push(`openApproval ${stepRunId} ${message}`);
    return 7;
  }

  async askHuman(_: unknown, attemptId: number, { result, kind, message }: AskHumanOptions) {
    this.finished.push({ result });
    this.store(attemptId, result);
    this.calls.push(`askHuman ${attemptId} ${result.status} ${kind}: ${message}`);
    return this.nextItemId++;
  }

  async askQuestion(_: unknown, attemptId: number, questions: Questions) {
    const text = questions.map(({ question }) => question).join(" ");
    this.calls.push(`askQuestion ${attemptId}: ${text}`);
    return this.nextItemId++;
  }

  async branchCreated(): Promise<never> {
    throw new Error("The engine does not create the branch");
  }

  async readAgentCredentials() {
    return [];
  }

  async readSetupSecrets() {
    return { values: [], missing: [] };
  }

  async readMirrorAccess() {
    return { owner: "acme", name: "app", token: "made-up" };
  }

  async readPushAccess() {
    return { commit: "made-up" };
  }

  async storePushedBranch() {}

  async readCommentAccess() {
    return { url: "made-up" };
  }

  async storeComment() {}

  async readTestCredentials() {
    return [];
  }

  async finishAgentTest() {}

  async reportSandbox(): Promise<never> {
    throw new Error("The engine does not report the sandbox");
  }

  async finishRun(_: unknown, result: string) {
    this.calls.push(`finishRun ${result}`);
  }

  private store(attemptId: number, result: AttemptResult) {
    const stepRunId = this.stepRunOfAttempt.get(attemptId) ?? 0;
    this.results.set(stepRunId, [...(this.results.get(stepRunId) ?? []), result]);
    return stepRunId;
  }

  private factsOf(stepRunId: number): StepFacts {
    const stored = this.results.get(stepRunId) ?? [];
    const usages = stored.flatMap(({ usage }) => (usage ? [usage] : []));
    const costs = usages.flatMap(({ costUsd }) => (costUsd === undefined ? [] : [costUsd]));
    const usage = usages.length > 0 && {
      activeMs: sumOf(usages.map(({ activeMs }) => activeMs)),
      ...(costs.length > 0 && { costUsd: sumOf(costs) }),
    };
    const commit = stored.findLast(({ checkpoint }) => checkpoint)?.checkpoint?.after;
    const sessionId = stored.findLast(({ sessionId }) => sessionId)?.sessionId;
    const files = [...new Set(stored.flatMap(({ checkpoint }) => checkpoint?.changedFiles ?? []))];
    return {
      ...(usage && { usage }),
      ...(commit && { commit }),
      ...(sessionId && { sessionId }),
      ...(files.length > 0 && limitChangedFiles(files)),
    };
  }
}
