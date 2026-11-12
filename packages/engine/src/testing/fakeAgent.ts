import type { Agent, AgentContext, AgentEvent, AgentSession } from "@halinka/agents";
import type { AgentAnswer, AgentQuestions } from "@halinka/protocol";

import type { FakeSandbox } from "./fakeSandbox";

export const reportPrompt = "report: ";

export const reportInstructions =
  "When you complete the task, call the `report_result` tool one time. " +
  "Give a short summary of what you did or found. " +
  "Call it yourself, not from a sub-agent. The task is not complete until you call it. " +
  "If you need a decision or information that only a person can give, " +
  "call the `ask_human` tool, then end your turn.";

export const askedQuestions: AgentQuestions = [
  {
    question: "Which database?",
    header: "Database",
    options: [
      { label: "Postgres", description: "The current database" },
      { label: "SQLite", description: "A file" },
    ],
    multiSelect: false,
  },
  { question: "Which checks?", header: "Checks", multiSelect: true },
];

export const answered: AgentAnswer = [
  { selected: ["SQLite"], other: null },
  { selected: [], other: "Lint and tests" },
];

type SessionState = { stepPrompt?: string; turns: number };

type CreateSessionOptions = { isLoaded: boolean };

export class FakeAgent implements Agent {
  readonly received: string[] = [];
  readonly late: Agent = {
    open: async (_context, signal) => {
      this.opens.resolve();
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
      return this.createSession("session-1", { isLoaded: false });
    },
  };
  readonly replay: Agent = {
    open: async () => ({
      sessionId: "session-1",
      isLoaded: false,
      prompt: async (text, { onEvent }) => {
        this.sandbox.agentWrites();
        const [stepPrompt] = text.split("\n");
        for (const update of JSON.parse(stepPrompt!) as AgentEvent[]) onEvent(update);
        return { stopReason: "end_turn", report: { summary: "Done" } };
      },
      close: async () => {},
    }),
  };
  private readonly runs = Promise.withResolvers<void>();
  private readonly opens = Promise.withResolvers<void>();
  // An unknown session id names the step prompt.
  private readonly sessions = new Map<string, SessionState>();
  private readonly lost = new Set<string>();
  private promptCount = 0;
  private closeCount = 0;
  private context: AgentContext | undefined;

  constructor(
    private readonly sandbox: FakeSandbox,
    private readonly abortRun: () => void,
  ) {}

  get running() {
    return this.runs.promise;
  }

  get opening() {
    return this.opens.promise;
  }

  prompted() {
    return this.promptCount;
  }

  closed() {
    return this.closeCount;
  }

  opened() {
    return this.context;
  }

  reportShape() {
    return this.context?.reportShape;
  }

  permissions() {
    return this.context?.permissions;
  }

  loadedSessionId() {
    return this.context?.sessionId;
  }

  async open(context: AgentContext) {
    this.context = context;
    const { sessionId } = context;
    if (sessionId === undefined || sessionId === "gone-session" || this.lost.has(sessionId)) {
      return this.createSession(`session-${this.sessions.size + 1}`, { isLoaded: false });
    }
    return this.createSession(sessionId, { isLoaded: true });
  }

  private createSession(sessionId: string, { isLoaded }: CreateSessionOptions): AgentSession {
    const state = this.sessions.get(sessionId) ?? {
      stepPrompt: isLoaded ? sessionId : undefined,
      turns: 0,
    };
    this.sessions.set(sessionId, state);
    return {
      sessionId,
      isLoaded,
      prompt: (text, options) => this.turn(state, text, options),
      close: async () => {
        this.closeCount++;
        this.sandbox.workspaceLog.push("close");
        if (state.stepPrompt?.includes("lose the session")) this.lost.add(sessionId);
        if (state.stepPrompt === "unclosable") throw new Error("The agent process did not stop");
      },
    };
  }

  private async turn(
    state: SessionState,
    text: string,
    { signal, interrupt, onEvent }: Parameters<AgentSession["prompt"]>[1],
  ): ReturnType<AgentSession["prompt"]> {
    this.sandbox.agentWrites();
    this.promptCount++;
    this.received.push(text);
    const turns = ++state.turns;
    state.stepPrompt ??= text.split("\n")[0] ?? "";
    const { stepPrompt } = state;
    if (stepPrompt === "fail before any update") throw new Error("The agent process exited");
    onEvent({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: stepPrompt },
    });
    onEvent({ sessionUpdate: "plan", entries: [] });
    if (stepPrompt === "split a lent value") {
      for (const text of ["token sk-lent", "-value-1 done"]) {
        onEvent({
          sessionUpdate: "agent_message_chunk",
          messageId: "m1",
          content: { type: "text", text },
        });
      }
      return { stopReason: "end_turn", report: { summary: "Done" } };
    }
    if (stepPrompt === "crash") throw new Error("The agent process exited");
    if (stepPrompt === "crash in a lent value") {
      onEvent({
        sessionUpdate: "agent_message_chunk",
        messageId: "m1",
        content: { type: "text", text: "token sk-lent" },
      });
      throw new Error("The agent process exited");
    }
    const spend = (amount: number) =>
      onEvent({
        sessionUpdate: "usage_update",
        used: 0,
        size: 0,
        cost: { amount, currency: "USD" },
      });
    const reportFrom = /^report from turn (\d+)$/.exec(stepPrompt);
    if (reportFrom) {
      if (turns < Number(reportFrom[1])) return { stopReason: "end_turn" };
      return { stopReason: "end_turn", report: { summary: "Done" } };
    }
    if (stepPrompt === "ignore cancel") {
      spend(3);
      throw new Error("The agent exited with code 1");
    }
    const reportCost = /^report cost (\d+)$/.exec(stepPrompt);
    if (reportCost) {
      const amount = Number(reportCost[1]) * turns;
      onEvent({
        sessionUpdate: "usage_update",
        used: 0,
        size: 0,
        cost: { amount, currency: "USD" },
      });
      return { stopReason: "end_turn", report: { summary: "Done" } };
    }
    const cost = /^cost (\d+)$/.exec(stepPrompt);
    if (cost) {
      const amount = Number(cost[1]);
      onEvent({
        sessionUpdate: "usage_update",
        used: 0,
        size: 0,
        cost: { amount, currency: "USD" },
      });
      return { stopReason: "end_turn" };
    }
    const interrupted = () =>
      new Promise((resolve) => interrupt?.addEventListener("abort", resolve));
    if (stepPrompt === "wait for chat" && turns === 1) {
      this.runs.resolve();
      await Promise.race([
        interrupted(),
        new Promise((resolve) => signal.addEventListener("abort", resolve)),
      ]);
      return { stopReason: "cancelled" };
    }
    if (stepPrompt === "forget, then wait for chat") {
      if (turns !== 2) return { stopReason: "end_turn" };
      this.runs.resolve();
      await interrupted();
      return { stopReason: "cancelled" };
    }
    if (stepPrompt === "report during chat" && turns === 1) {
      this.runs.resolve();
      await interrupted();
      return { stopReason: "cancelled", report: { summary: "Early" } };
    }
    if (stepPrompt === "slow") {
      this.runs.resolve();
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
      return { stopReason: "cancelled" };
    }
    if (stepPrompt === "hang") {
      this.runs.resolve();
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
      return { stopReason: "cancelled", report: { summary: "Too late" } };
    }
    if (stepPrompt === "ask" && turns === 1) {
      return { stopReason: "end_turn", questions: askedQuestions };
    }
    if (stepPrompt === "ask, then lose the session" && !text.includes("A person answered")) {
      return { stopReason: "end_turn", questions: askedQuestions };
    }
    if (
      stepPrompt === "ask twice, then lose the session" &&
      text.split("A person answered").length < 3
    ) {
      return { stopReason: "end_turn", questions: askedQuestions };
    }
    if (stepPrompt === "ask with cost 2, then lose the session") {
      onEvent({
        sessionUpdate: "usage_update",
        used: 0,
        size: 0,
        cost: { amount: 2 * turns, currency: "USD" },
      });
      if (!text.includes("A person answered")) {
        return { stopReason: "end_turn", questions: askedQuestions };
      }
      return { stopReason: "end_turn", report: { summary: "Done" } };
    }
    if (stepPrompt === "ask with cost 2") {
      onEvent({
        sessionUpdate: "usage_update",
        used: 0,
        size: 0,
        cost: { amount: 2 * turns, currency: "USD" },
      });
      if (turns === 1) return { stopReason: "end_turn", questions: askedQuestions };
      return { stopReason: "end_turn", report: { summary: "Done" } };
    }
    if (stepPrompt === "ask and report") {
      return { stopReason: "end_turn", questions: askedQuestions, report: { summary: "Done" } };
    }
    if (stepPrompt === "ask and refuse") {
      return { stopReason: "refusal", questions: askedQuestions };
    }
    if (stepPrompt === "forget then ask") {
      return turns === 2
        ? { stopReason: "end_turn", questions: askedQuestions }
        : { stopReason: "end_turn" };
    }
    if (stepPrompt === "invalid questions once" && turns === 1) {
      return { stopReason: "end_turn", questionProblems: "Too small at questions" };
    }
    if (stepPrompt === "abort the run") this.abortRun();
    if (stepPrompt === "refuse") return { stopReason: "refusal" };
    if (stepPrompt === "refuse after report") {
      return { stopReason: "refusal", report: { summary: "Done" } };
    }
    if (stepPrompt === "invalid then max tokens") {
      return { stopReason: "max_tokens", reportProblems: "Invalid option at outcome" };
    }
    if (stepPrompt.startsWith(reportPrompt)) {
      return {
        stopReason: "end_turn",
        report: JSON.parse(stepPrompt.slice(reportPrompt.length)),
      };
    }
    if (stepPrompt === "invalid" || (stepPrompt === "invalid once" && turns === 1)) {
      return { stopReason: "end_turn", reportProblems: "Invalid option at outcome" };
    }
    if (
      stepPrompt === "silent" ||
      stepPrompt === "abort the run" ||
      (stepPrompt === "forgetful" && turns === 1)
    ) {
      return { stopReason: "end_turn" };
    }
    return { stopReason: "end_turn", report: { summary: `Done: ${stepPrompt}` } };
  }
}
