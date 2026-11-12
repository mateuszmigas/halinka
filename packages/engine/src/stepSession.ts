import type { Agent, AgentEvent, AgentSession, AgentTurn } from "@halinka/agents";
import type { AgentQuestions, ReopenedStep, Usage } from "@halinka/protocol";
import { errorMessage } from "@halinka/utils/errors";
import { type AgentStep, stepPermissions, type StepReport } from "@halinka/workflow";

import { type LimitName, Limits, type LoopBudget, type RunBudget } from "./limits";
import { MaskedAgentText } from "./maskedStream";
import { answerPrompt, type BasePrompt, messagePrompt, reminderOf, toldNote } from "./prompts";
import { waitForDecision } from "./runAttempts";
import type { StepContext } from "./runDeps";

export type StepSessionOptions = {
  stepRunId: number;
  agent: Agent | undefined;
  loop?: LoopBudget;
  runBudget?: RunBudget;
  used?: Usage;
  basePrompt: (prompt: BasePrompt) => string;
  // the session to load at the first open
  earlier?: Pick<ReopenedStep, "sessionId" | "sessionCostUsd">;
  told?: string[];
};

export type TurnsResult = StepReport | { error: string } | { limit: LimitName };

// `retryText`: without it, a loaded session gets the short note
type AttemptTurns = { attemptId: number; retryText?: string; isInterrupted: boolean };

type Answered = { itemId: number; author: string };

type TurnPrompt = { ownText?: string; answered?: Answered; isAttemptStart?: boolean };

type PromptedTurn = AgentTurn & { limit?: LimitName; isInterrupted: boolean };

const defaultMaxReminders = 2;

// Opens at the first turn, so an open failure fails the attempt; a give-back stops the agent.
export class StepSession {
  readonly limits: Limits;
  private session: AgentSession | undefined;
  private live: string | undefined;
  private announcedId: string | undefined;
  // the open session has the step prompt in its history
  private isPrimed = false;
  // the base prompt of the attempt gets the note that the step stopped
  private isRestarted = false;
  private readonly told: string[];
  private attemptStart!: { usage: Usage; mark: ReturnType<Limits["sessionMark"]> };

  constructor(
    private readonly context: StepContext,
    private readonly step: AgentStep,
    private readonly options: StepSessionOptions,
  ) {
    const { loop, used, runBudget, told = [] } = options;
    this.limits = new Limits(step, { loop, used, run: runBudget });
    this.told = [...told];
    this.startAttempt();
  }

  startAttempt() {
    this.attemptStart = { usage: this.limits.usage(), mark: this.limits.sessionMark() };
  }

  attemptFacts() {
    const { usage, mark } = this.attemptStart;
    const sessionCostUsd = this.limits.sessionCostSince(mark);
    return {
      usage: this.limits.usageSince(usage),
      sessionId: this.live,
      ...(sessionCostUsd !== undefined && { sessionCostUsd }),
    };
  }

  // Checkpoints and gates need the host user as the owner.
  async withWorkspace<T>(run: () => Promise<T>) {
    try {
      await this.context.deps.sandbox.assignWorkspace("agent");
      return await run();
    } finally {
      await this.giveBack();
    }
  }

  async runTurns(
    { attemptId, retryText, isInterrupted }: AttemptTurns,
    signal: AbortSignal,
  ): Promise<TurnsResult> {
    const { step, limits } = this;
    this.isRestarted = isInterrupted;
    const reachedBefore = limits.reached();
    if (reachedBefore) return { limit: reachedBefore };
    let turn = await this.prompt(attemptId, { ownText: retryText, isAttemptStart: true }, signal);
    const maxReminders = step.max_reminders ?? defaultMaxReminders;
    let reminders = 0;
    for (;;) {
      const limit = turn.limit ?? limits.reached();
      // A message wins over a report and a question of the same turn, but not over a limit.
      if (turn.isInterrupted) {
        if (limit) return { limit };
        turn = await this.prompt(attemptId, {}, signal);
        reminders = 0;
        continue;
      }
      // A report wins over a question and over a limit that the same turn reached.
      if (turn.report) return turn.report;
      if (limit) return { limit };
      if (turn.stopReason !== "end_turn") break;
      if (turn.questions) {
        const answer = await this.ask(attemptId, turn.questions, signal);
        this.isRestarted = true;
        turn = await this.prompt(
          attemptId,
          { ownText: answer?.text, answered: answer?.answered },
          signal,
        );
        reminders = 0;
        continue;
      }
      if (reminders >= maxReminders) break;
      reminders++;
      turn = await this.prompt(attemptId, { ownText: reminderOf(turn) }, signal);
    }
    const problems = turn.reportProblems
      ? `The report of the agent is not valid:\n${turn.reportProblems}`
      : turn.questionProblems &&
        `The questions of the agent are not valid:\n${turn.questionProblems}`;
    if (turn.stopReason !== "end_turn") {
      const stopped = `The agent stopped the turn: ${turn.stopReason}`;
      return { error: problems ? `${stopped}\n${problems}` : stopped };
    }
    return { error: problems || "The agent did not report a result" };
  }

  async close() {
    const { session } = this;
    this.session = undefined;
    await session?.close().catch((error: unknown) => {
      console.error(
        `Run ${this.context.lease.workflowRunId}: the agent session did not close`,
        error,
      );
    });
  }

  private async prompt(
    attemptId: number,
    turnPrompt: TurnPrompt,
    signal: AbortSignal,
  ): Promise<PromptedTurn> {
    const { step, limits } = this;
    const { events, deps } = this.context;
    const session = await this.open(attemptId, signal);
    signal.throwIfAborted();
    const { text, storedText, messages } = this.takePrompt(turnPrompt);
    const withMessages = (promptText: string | undefined) =>
      [...(promptText === undefined ? [] : [promptText]), ...messages.map(messagePrompt)].join(
        "\n\n",
      );
    events.emit({
      kind: "agent_prompt",
      payload: {
        stepId: step.id,
        attemptId,
        text: withMessages(storedText),
        ...(messages.length > 0 && {
          baseText: storedText ?? "",
          messages: messages.map(({ messageId, author, text }) => ({ messageId, author, text })),
        }),
        ...(turnPrompt.answered && { answered: turnPrompt.answered }),
      },
    });
    const interrupt = new AbortController();
    const turnEnded = new AbortController();
    deps.inbox
      .messageArrived(this.options.stepRunId, AbortSignal.any([signal, turnEnded.signal]))
      .then(
        () => interrupt.abort(),
        () => {},
      );
    const limitControl = new AbortController();
    let reached: LimitName | undefined;
    const stop = (limit: LimitName) => {
      reached ??= limit;
      limitControl.abort();
    };
    const timeLeft = limits.timeLeft();
    const timer = timeLeft && setTimeout(stop, timeLeft.ms, timeLeft.limit);
    const started = Date.now();
    const agentText = new MaskedAgentText(deps.lent);
    const store = (updates: AgentEvent[]) => {
      for (const update of updates) {
        if (update.sessionUpdate === "available_commands_update") continue;
        events.emit({ kind: "agent_update", payload: { stepId: step.id, attemptId, update } });
      }
    };
    try {
      const turn = await session.prompt(withMessages(text), {
        signal: AbortSignal.any([signal, limitControl.signal]),
        interrupt: interrupt.signal,
        onEvent: (update) => {
          this.announce(attemptId);
          limits.count(update);
          const limit = limits.reached();
          if (limit) stop(limit);
          store(agentText.push(update));
        },
      });
      limits.countTurn();
      this.announce(attemptId);
      return { ...turn, limit: reached, isInterrupted: interrupt.signal.aborted };
    } catch (error) {
      if (!reached || signal.aborted) throw error;
      throw new Error(
        `The agent reached ${limits.label(reached)} and did not end its turn. ` +
          `Halinka stopped the agent: ${errorMessage(error)}`,
        { cause: error },
      );
    } finally {
      store(agentText.end());
      turnEnded.abort();
      clearTimeout(timer);
      limits.addTime(Date.now() - started);
    }
  }

  // `storedText` holds no earlier text: the transcript has it, and an event has a size limit.
  private takePrompt({ ownText, answered, isAttemptStart = false }: TurnPrompt) {
    const { told } = this;
    // A new session has no history, so it gets the step first.
    const isBasePromptRequired = !this.isPrimed || (isAttemptStart && ownText === undefined);
    const textWith = (toldTexts: string[]) => {
      const base = isBasePromptRequired
        ? this.options.basePrompt({
            isLoaded: this.isPrimed,
            isInterrupted: this.isRestarted,
            told: toldTexts,
          })
        : undefined;
      const parts = [base, ownText].filter((part) => part !== undefined);
      return parts.length > 0 ? parts.join("\n\n") : undefined;
    };
    const text = textWith(told);
    const storedText = textWith(told.length > 0 ? [toldNote(told.length)] : []);
    this.isPrimed = true;
    const messages = this.context.deps.inbox.takeMessages(this.options.stepRunId);
    if (answered && ownText) told.push(ownText);
    told.push(...messages.map(messagePrompt));
    return { text, storedText, messages };
  }

  private async ask(attemptId: number, questions: AgentQuestions, signal: AbortSignal) {
    const { deps, lease, events } = this.context;
    await events.flushBefore(signal);
    signal.throwIfAborted();
    const itemId = await deps.plane.askQuestion(lease, attemptId, questions);
    const waited = new AbortController();
    const waiting = AbortSignal.any([signal, waited.signal]);
    // A person can edit the workspace while the run waits.
    await this.giveBack();
    try {
      const delivered = await Promise.race([
        waitForDecision(deps.inbox, { kind: "question", itemId }, waiting),
        deps.inbox.messageArrived(this.options.stepRunId, waiting).then(() => undefined),
      ]);
      if (!delivered) return undefined;
      const { answer, resolvedBy } = delivered;
      if (!answer) throw new Error(`Inbox item ${itemId} has no answer`);
      const answered = { itemId, author: resolvedBy };
      return { text: answerPrompt(questions, answer), answered };
    } finally {
      waited.abort();
      await deps.sandbox.assignWorkspace("agent");
    }
  }

  private async open(attemptId: number, signal: AbortSignal) {
    if (this.session) return this.session;
    const { step, live } = this;
    const { agent, earlier } = this.options;
    if (!agent) throw new Error(`The agent "${step.agent}" is not available`);
    const { sandbox } = this.context.deps;
    const session = await agent.open(
      {
        sandbox,
        reportShape: { outcomes: step.outcomes, outputs: step.outputs },
        permissions: stepPermissions(step),
        sessionId: live ?? earlier?.sessionId,
        model: step.model ?? this.context.agentModels[step.agent],
        tools: step.tools,
        mcp_servers: step.mcp_servers,
      },
      signal,
    );
    this.session = session;
    this.live = session.sessionId;
    // A reload of the live session has the history that the live session had.
    this.isPrimed = session.isLoaded && (live === undefined || this.isPrimed);
    this.limits.sessionOpened({
      isReplacingLive: live !== undefined,
      isLoaded: session.isLoaded,
      loadedCostUsd: earlier?.sessionCostUsd ?? 0,
    });
    if (session.isLoaded) this.announce(attemptId);
    return session;
  }

  private async giveBack() {
    await this.close();
    await this.context.deps.sandbox.assignWorkspace("host");
  }

  // Only a prompted session: a later attempt loads it with the short note, not the step prompt.
  private announce(attemptId: number) {
    const sessionId = this.session?.sessionId;
    if (sessionId === undefined || sessionId === this.announcedId) return;
    const isReplacing = this.announcedId !== undefined;
    this.announcedId = sessionId;
    const { usage, sessionCostUsd = 0 } = this.attemptFacts();
    // A crash before the attempt finishes would lose the spend of the replaced session.
    const replacedCostUsd =
      isReplacing && usage.costUsd !== undefined
        ? Math.max(0, usage.costUsd - sessionCostUsd)
        : undefined;
    this.context.events.emit({
      kind: "agent_session",
      payload: {
        stepId: this.step.id,
        attemptId,
        sessionId,
        ...(replacedCostUsd !== undefined && { replacedCostUsd }),
      },
    });
  }
}
