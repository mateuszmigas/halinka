import type { AgentEvent } from "@halinka/agents";
import type { RecordedStep, Usage } from "@halinka/protocol";
import { type AgentStep, durationMs, type LoopStep, type Workflow } from "@halinka/workflow";

const stepLimits = ["max_turns", "timeout", "max_cost_usd"] as const;

export type StepLimit = (typeof stepLimits)[number];

type LoopLimit = "loop_timeout" | "loop_max_cost_usd";

export type LimitName = StepLimit | LoopLimit | "run_max_cost_usd";

export const isStepLimit = (limit: LimitName): limit is StepLimit =>
  stepLimits.some((stepLimit) => stepLimit === limit);

// `used`: the loop's usage before this step started
export type LoopBudget = { step: LoopStep; used: Usage };

export type RunBudget = { maxUsd: number; usedUsd: number };

type Allowance = Partial<Record<LimitName, number>>;

// A loop limit comes first on a tie: a person cannot raise it.
const timeLimits = ["loop_timeout", "timeout"] as const;

export const addUsage = (first?: Usage, second?: Usage): Usage | undefined => {
  if (!first || !second) return first ?? second;
  const activeMs = first.activeMs + second.activeMs;
  if (first.costUsd === undefined && second.costUsd === undefined) return { activeMs };
  return { activeMs, costUsd: (first.costUsd ?? 0) + (second.costUsd ?? 0) };
};

export const loopAllowance = ({
  step: { timeout, max_cost_usd },
  used,
}: LoopBudget): Allowance => ({
  loop_timeout: timeout === undefined ? undefined : durationMs(timeout) - used.activeMs,
  loop_max_cost_usd: max_cost_usd === undefined ? undefined : max_cost_usd - (used.costUsd ?? 0),
});

export const loopLimitLabel = (limit: LoopLimit, { id, timeout, max_cost_usd }: LoopStep) =>
  limit === "loop_timeout"
    ? `timeout (${timeout}) of the loop \`${id}\``
    : `max_cost_usd ($${max_cost_usd}) of the loop \`${id}\``;

export const loopLimitReached = (loop: LoopBudget): LoopLimit | undefined => {
  const { loop_timeout, loop_max_cost_usd } = loopAllowance(loop);
  if (loop_max_cost_usd !== undefined && loop_max_cost_usd < 0) return "loop_max_cost_usd";
  if (loop_timeout !== undefined && loop_timeout <= 0) return "loop_timeout";
  return undefined;
};

export const runBudgetOf = (
  { max_cost_usd }: Workflow,
  recorded: RecordedStep[],
): RunBudget | undefined =>
  max_cost_usd === undefined
    ? undefined
    : {
        maxUsd: max_cost_usd,
        usedUsd: recorded.reduce((sum, { usage }) => sum + (usage?.costUsd ?? 0), 0),
      };

export const runLimitLabel = (maxUsd: number) => `max_cost_usd ($${maxUsd}) of the workflow`;

export const isRunLimitReached = ({ maxUsd, usedUsd }: RunBudget) => usedUsd > maxUsd;

type SessionMark = { sessions: number; spendUsd: number };

// `used`: the recorded usage of the step run before this engine, after a recovery
type LimitsOptions = { loop?: LoopBudget; used?: Usage; run?: RunBudget };

// The limits of one agent session, and the rest of the limits of its loop and its run.
export class Limits {
  private readonly initial: Allowance;
  private readonly allowed: Allowance;
  private turns = 0;
  private agentMs = 0;
  private sessionCostUsd: number | undefined;
  // the spend of the open session in this engine
  private sessionSpendUsd: number | undefined;
  private loadedCostUsd = 0;
  private replacedSessionsCostUsd = 0;
  private sessions = 0;

  private readonly loop: LoopBudget | undefined;
  private readonly run: RunBudget | undefined;

  constructor(
    private readonly step: AgentStep,
    { loop, used = { activeMs: 0 }, run }: LimitsOptions = {},
  ) {
    this.loop = loop;
    this.run = run;
    const { max_turns, timeout, max_cost_usd } = step;
    this.initial = {
      max_turns,
      timeout: timeout === undefined ? undefined : durationMs(timeout),
      max_cost_usd,
    };
    const { timeout: initialMs } = this.initial;
    this.allowed = {
      max_turns,
      timeout: initialMs === undefined ? undefined : initialMs - used.activeMs,
      max_cost_usd: max_cost_usd === undefined ? undefined : max_cost_usd - (used.costUsd ?? 0),
      ...(loop && loopAllowance(loop)),
      ...(run && { run_max_cost_usd: run.maxUsd - run.usedUsd }),
    };
  }

  count(update: AgentEvent) {
    if (update.sessionUpdate === "usage_update" && update.cost) {
      this.sessionSpendUsd = Math.max(0, update.cost.amount - this.loadedCostUsd);
      this.sessionCostUsd = this.replacedSessionsCostUsd + this.sessionSpendUsd;
    }
  }

  // `isReplacingLive`: a session of this engine was open before
  sessionOpened({
    isReplacingLive,
    isLoaded,
    loadedCostUsd,
  }: {
    isReplacingLive: boolean;
    isLoaded: boolean;
    loadedCostUsd: number;
  }) {
    // The cost of a loaded session counts its earlier turns.
    if (!isReplacingLive) {
      if (isLoaded) this.loadedCostUsd = loadedCostUsd;
      return;
    }
    // A reload of the live session keeps its cost baseline.
    if (isLoaded) return;
    // A new session reports its cost from 0.
    this.replacedSessionsCostUsd = this.sessionCostUsd ?? this.replacedSessionsCostUsd;
    this.sessionSpendUsd = undefined;
    this.loadedCostUsd = 0;
    this.sessions++;
  }

  sessionMark(): SessionMark {
    return { sessions: this.sessions, spendUsd: this.sessionSpendUsd ?? 0 };
  }

  // The cost of the open session since the mark: a session that replaced the marked one counts whole.
  sessionCostSince({ sessions, spendUsd }: SessionMark) {
    if (this.sessionSpendUsd === undefined) return undefined;
    return Math.max(0, this.sessionSpendUsd - (sessions === this.sessions ? spendUsd : 0));
  }

  addTime(ms: number) {
    this.agentMs += ms;
  }

  countTurn() {
    this.turns++;
  }

  usage(): Usage {
    const { agentMs, sessionCostUsd } = this;
    return { activeMs: agentMs, ...(sessionCostUsd !== undefined && { costUsd: sessionCostUsd }) };
  }

  usageSince({ activeMs, costUsd = 0 }: Usage): Usage {
    const now = this.usage();
    return {
      activeMs: now.activeMs - activeMs,
      ...(now.costUsd !== undefined && { costUsd: Math.max(0, now.costUsd - costUsd) }),
    };
  }

  timeLeft(): { ms: number; limit: LimitName } | undefined {
    const left = timeLimits.flatMap((limit) => {
      const allowed = this.allowed[limit];
      return allowed === undefined ? [] : [{ ms: Math.max(0, allowed - this.agentMs), limit }];
    });
    return left.sort((first, second) => first.ms - second.ms)[0];
  }

  // `max_turns` counts ended turns, so it stops the next prompt and never a turn.
  reached(): LimitName | undefined {
    const { max_turns, timeout, max_cost_usd, loop_timeout, loop_max_cost_usd, run_max_cost_usd } =
      this.allowed;
    const cost = this.sessionCostUsd ?? 0;
    if (max_turns !== undefined && this.turns >= max_turns) return "max_turns";
    if (run_max_cost_usd !== undefined && cost > run_max_cost_usd) return "run_max_cost_usd";
    if (loop_max_cost_usd !== undefined && cost > loop_max_cost_usd) return "loop_max_cost_usd";
    if (max_cost_usd !== undefined && cost > max_cost_usd) return "max_cost_usd";
    if (loop_timeout !== undefined && this.agentMs >= loop_timeout) return "loop_timeout";
    if (timeout !== undefined && this.agentMs >= timeout) return "timeout";
    return undefined;
  }

  raise(limit: StepLimit) {
    this.allowed[limit] = (this.allowed[limit] ?? 0) + (this.initial[limit] ?? 0);
  }

  label(limit: LimitName) {
    const { step, loop, run } = this;
    switch (limit) {
      case "run_max_cost_usd":
        return run ? runLimitLabel(run.maxUsd) : limit;
      case "max_turns":
        return `max_turns (${step.max_turns} turns)`;
      case "timeout":
        return `timeout (${step.timeout} of agent time)`;
      case "max_cost_usd":
        return `max_cost_usd ($${step.max_cost_usd})`;
      case "loop_timeout":
      case "loop_max_cost_usd":
        return loop ? loopLimitLabel(limit, loop.step) : limit;
    }
  }
}
