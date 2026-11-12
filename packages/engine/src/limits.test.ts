import type { AgentEvent } from "@halinka/agents";
import type { Usage } from "@halinka/protocol";
import type { LoopStep } from "@halinka/workflow";
import { describe, expect, it } from "vitest";

import { Limits } from "./limits";
import { agentStep, loopStep } from "./testing";

const loopBudget = (fields: Partial<LoopStep>, used: Usage = { activeMs: 0 }) => ({
  step: loopStep([], fields),
  used,
});

const usage = (amount: number): AgentEvent => ({
  sessionUpdate: "usage_update",
  used: 0,
  size: 0,
  cost: { amount, currency: "USD" },
});

describe("Limits", () => {
  it("reaches the limit of the run with the cost of earlier steps", () => {
    const limits = new Limits(agentStep({}), { run: { maxUsd: 3, usedUsd: 2 } });

    limits.count(usage(1.5));

    expect(limits.reached()).toBe("run_max_cost_usd");
  });

  it("does not reach the limit of the run at exactly it", () => {
    const limits = new Limits(agentStep({}), { run: { maxUsd: 3, usedUsd: 2 } });

    limits.count(usage(1));

    expect(limits.reached()).toBeUndefined();
  });

  it("reaches the run's limit first when the step's limit is the same", () => {
    const limits = new Limits(agentStep({ max_cost_usd: 2 }), {
      run: {
        maxUsd: 2,
        usedUsd: 0,
      },
    });

    limits.count(usage(3));

    expect(limits.reached()).toBe("run_max_cost_usd");
  });

  it("does not raise the run's limit with the step's limit", () => {
    const limits = new Limits(agentStep({ max_cost_usd: 2 }), {
      run: {
        maxUsd: 3,
        usedUsd: 0,
      },
    });
    limits.raise("max_cost_usd");

    limits.count(usage(3.5));

    expect(limits.reached()).toBe("run_max_cost_usd");
  });

  it("takes the last cost of the session, not a sum", () => {
    const limits = new Limits(agentStep({ max_cost_usd: 2 }));

    limits.count(usage(1));
    limits.count(usage(1.5));

    expect(limits.reached()).toBeUndefined();
  });

  it("reaches max_cost_usd only with the cost after the loaded session cost", () => {
    const limits = new Limits(agentStep({ max_cost_usd: 2 }));
    limits.sessionOpened({ isReplacingLive: false, isLoaded: true, loadedCostUsd: 5 });

    limits.count(usage(6.5));

    expect(limits.reached()).toBeUndefined();
  });

  it("adds the cost of a new session to the cost of the session that it replaced", () => {
    const limits = new Limits(agentStep({ max_cost_usd: 4 }));
    limits.sessionOpened({ isReplacingLive: false, isLoaded: true, loadedCostUsd: 1 });
    limits.count(usage(3));

    limits.sessionOpened({ isReplacingLive: true, isLoaded: false, loadedCostUsd: 1 });
    limits.count(usage(2.5));

    expect(limits.usage().costUsd).toBe(4.5);
  });

  it("keeps the cost baseline when the live session loads again", () => {
    const limits = new Limits(agentStep({ max_cost_usd: 4 }));
    limits.sessionOpened({ isReplacingLive: false, isLoaded: true, loadedCostUsd: 1 });
    limits.count(usage(3));

    limits.sessionOpened({ isReplacingLive: true, isLoaded: true, loadedCostUsd: 1 });
    limits.count(usage(3.5));

    expect(limits.usage().costUsd).toBe(2.5);
  });

  it("gives the cost of the open session since the mark", () => {
    const limits = new Limits(agentStep({}));
    limits.count(usage(1));
    const mark = limits.sessionMark();

    limits.count(usage(3));

    expect(limits.sessionCostSince(mark)).toBe(2);
  });

  it("gives the whole cost of a session that replaced the marked one", () => {
    const limits = new Limits(agentStep({}));
    limits.count(usage(1));
    const mark = limits.sessionMark();

    limits.sessionOpened({ isReplacingLive: true, isLoaded: false, loadedCostUsd: 0 });
    limits.count(usage(0.5));

    expect(limits.sessionCostSince(mark)).toBe(0.5);
  });

  it("gives no negative session cost when a loaded session reports less than its mark", () => {
    const limits = new Limits(agentStep({}));
    limits.sessionOpened({ isReplacingLive: false, isLoaded: true, loadedCostUsd: 1 });
    limits.count(usage(3));
    const mark = limits.sessionMark();

    limits.sessionOpened({ isReplacingLive: true, isLoaded: true, loadedCostUsd: 1 });
    limits.count(usage(0.5));

    expect(limits.sessionCostSince(mark)).toBe(0);
  });

  it("gives no negative usage when a loaded session reports less than before", () => {
    const limits = new Limits(agentStep({}));
    limits.sessionOpened({ isReplacingLive: false, isLoaded: true, loadedCostUsd: 1 });
    limits.count(usage(3));
    const start = limits.usage();

    limits.sessionOpened({ isReplacingLive: true, isLoaded: true, loadedCostUsd: 1 });
    limits.count(usage(0.5));

    expect(limits.usageSince(start).costUsd).toBe(0);
  });

  it("counts the recorded cost of the step run toward max_cost_usd", () => {
    const limits = new Limits(agentStep({ max_cost_usd: 4 }), {
      used: {
        activeMs: 0,
        costUsd: 3,
      },
    });

    limits.count(usage(1.5));

    expect(limits.reached()).toBe("max_cost_usd");
  });

  it("counts the recorded time of the step run toward timeout", () => {
    const limits = new Limits(agentStep({ timeout: "1m" }), { used: { activeMs: 45_000 } });

    expect(limits.timeLeft()).toEqual({ ms: 15_000, limit: "timeout" });
  });

  it("gives the agent time that is left", () => {
    const limits = new Limits(agentStep({ timeout: "1m" }));

    limits.addTime(20_000);

    expect(limits.timeLeft()).toEqual({ ms: 40_000, limit: "timeout" });
  });

  it("reaches the timeout when the agent time is used up", () => {
    const limits = new Limits(agentStep({ timeout: "1m" }));

    limits.addTime(60_000);

    expect(limits.reached()).toBe("timeout");
  });

  it("reaches max_turns when that many turns ended", () => {
    const limits = new Limits(agentStep({ max_turns: 2 }));

    limits.countTurn();
    const afterOne = limits.reached();
    limits.countTurn();

    expect(afterOne).toBeUndefined();
    expect(limits.reached()).toBe("max_turns");
  });

  it("does not count a tool call as a turn", () => {
    const limits = new Limits(agentStep({ max_turns: 1 }));

    limits.count({ sessionUpdate: "tool_call", toolCallId: "1", title: "Read" });

    expect(limits.reached()).toBeUndefined();
  });

  it("adds max_turns turns to a raised max_turns", () => {
    const limits = new Limits(agentStep({ max_turns: 2 }));
    limits.countTurn();
    limits.countTurn();

    limits.raise("max_turns");
    limits.countTurn();

    expect(limits.reached()).toBeUndefined();
  });

  it("adds the starting amount to a raised limit", () => {
    const limits = new Limits(agentStep({ timeout: "1m" }));
    limits.addTime(60_000);

    limits.raise("timeout");

    expect(limits.timeLeft()).toEqual({ ms: 60_000, limit: "timeout" });
  });

  it("gives no time left for a step without a timeout", () => {
    expect(new Limits(agentStep({})).timeLeft()).toBeUndefined();
  });

  it("reaches the loop's max_cost_usd with the cost that the loop used before", () => {
    const limits = new Limits(agentStep({}), {
      loop: loopBudget({ max_cost_usd: 5 }, { activeMs: 0, costUsd: 4 }),
    });

    limits.count(usage(1.5));

    expect(limits.reached()).toBe("loop_max_cost_usd");
  });

  it("does not raise the loop's limit with the step's limit", () => {
    const limits = new Limits(agentStep({ timeout: "1m" }), {
      loop: loopBudget({ timeout: "90s" }),
    });
    limits.addTime(60_000);
    limits.raise("timeout");

    limits.addTime(30_000);

    expect(limits.reached()).toBe("loop_timeout");
  });

  it("gives the time left until the loop's timeout when it comes first", () => {
    const loop = loopBudget({ timeout: "10m" }, { activeMs: 570_000 });

    const limits = new Limits(agentStep({ timeout: "1m" }), { loop });

    expect(limits.timeLeft()).toEqual({ ms: 30_000, limit: "loop_timeout" });
  });

  it("gives the time left until the step's timeout when it comes first", () => {
    const limits = new Limits(agentStep({ timeout: "1m" }), {
      loop: loopBudget({ timeout: "10m" }),
    });

    expect(limits.timeLeft()).toEqual({ ms: 60_000, limit: "timeout" });
  });

  it("reaches the loop's limit first when the step's limit is the same", () => {
    const limits = new Limits(agentStep({ max_cost_usd: 2 }), {
      loop: loopBudget({ max_cost_usd: 2 }),
    });

    limits.count(usage(3));

    expect(limits.reached()).toBe("loop_max_cost_usd");
  });

  it("gives the loop's timeout when it ends at the same time as the step's", () => {
    const limits = new Limits(agentStep({ timeout: "1m" }), {
      loop: loopBudget({ timeout: "1m" }),
    });

    expect(limits.timeLeft()).toEqual({ ms: 60_000, limit: "loop_timeout" });
  });

  it("gives the usage since a start", () => {
    const limits = new Limits(agentStep({}));
    limits.count(usage(1));
    limits.addTime(1000);
    const start = limits.usage();

    limits.count(usage(3));
    limits.addTime(500);

    expect(limits.usageSince(start)).toEqual({ activeMs: 500, costUsd: 2 });
  });

  it("gives no cost in the usage of an agent that reports none", () => {
    const limits = new Limits(agentStep({}));

    limits.addTime(500);

    expect(limits.usage()).toEqual({ activeMs: 500 });
  });
});
