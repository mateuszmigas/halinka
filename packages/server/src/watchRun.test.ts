import { fakeTimers } from "@halinka/utils/testing";
import { ORPCError } from "@orpc/client";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { StoredRunEvent } from "./client";
import { watchRun, type WatchRunOptions } from "./watchRun";

type Connection = Parameters<WatchRunOptions["onEvents"]>[0] | "state" | Error;

const storedEvent = (seq: number): StoredRunEvent => ({
  seq,
  createdAt: "",
  event: {
    kind: "output",
    payload: { stepId: "build", attemptId: 1, stream: "stdout", text: "x" },
  },
});

type SetUpOptions = { reconnectDelayMs?: number; pollMs?: number };

// Each connection gives its messages and ends, or throws at an Error; after the last one the watch aborts.
const setUpWith = (options: SetUpOptions, ...connections: Connection[][]) => {
  const { reconnectDelayMs = 1, pollMs } = options;
  const controller = new AbortController();
  onTestFinished(() => controller.abort());
  const inputs: { id: number; after: number }[] = [];
  const events: number[] = [];
  const onState = vi.fn();
  const watch: WatchRunOptions["watch"] = async (input) => {
    inputs.push(input);
    const messages = connections.shift();
    if (!messages) {
      controller.abort();
      return (async function* () {})();
    }
    return (async function* () {
      for (const message of messages) {
        if (message instanceof Error) throw message;
        yield message === "state"
          ? { type: "state" as const }
          : { type: "events" as const, events: message };
      }
    })();
  };
  const done = watchRun({
    watch,
    workflowRunId: 7,
    signal: controller.signal,
    reconnectDelayMs,
    pollMs,
    onEvents: (next) => events.push(...next.map(({ seq }) => seq)),
    onState,
  });
  return { done, inputs, events, onState, controller };
};

const setUp = (...connections: Connection[][]) => setUpWith({}, ...connections);

describe("watchRun", () => {
  it("reconnects after the last seq when the stream fails", async () => {
    const { done, inputs, events } = setUp(
      [[storedEvent(1), storedEvent(2)], new Error("drop")],
      [[storedEvent(3)]],
    );

    await done;

    expect(inputs).toEqual([
      { id: 7, after: 0 },
      { id: 7, after: 2 },
      { id: 7, after: 3 },
    ]);
    expect(events).toEqual([1, 2, 3]);
  });

  it("reconnects after the last seq when the stream ends", async () => {
    const { done, inputs } = setUp([[storedEvent(4)]]);

    await done;

    expect(inputs.map(({ after }) => after)).toEqual([0, 4]);
  });

  it("stops with an error of the contract", async () => {
    const notFound = new ORPCError("NOT_FOUND", { defined: true });
    const { done, inputs } = setUp([notFound]);

    expect(await done).toBe(notFound);
    expect(inputs).toHaveLength(1);
  });

  it("stops without a reconnect after an abort", async () => {
    const { done, inputs, controller } = setUp([[storedEvent(1)]]);
    controller.abort();

    expect(await done).toBeUndefined();
    expect(inputs).toHaveLength(1);
  });

  it("stops during the wait before a reconnect when the signal aborts", async () => {
    const { done, events, controller } = setUpWith({ reconnectDelayMs: 60_000 }, [
      [storedEvent(1)],
    ]);
    await vi.waitFor(() => expect(events).toEqual([1]));

    controller.abort();

    expect(await done).toBeUndefined();
  });

  it("reports each state change", async () => {
    const { done, onState } = setUp(["state", [storedEvent(1)], "state"]);

    await done;

    expect(onState).toHaveBeenCalledTimes(2);
  });

  it("reports the state at each interval", async () => {
    fakeTimers();
    const { onState } = setUpWith({ reconnectDelayMs: 60_000, pollMs: 1000 }, []);

    await vi.advanceTimersByTimeAsync(2000);

    expect(onState).toHaveBeenCalledTimes(2);
  });

  it("stops the interval at the end", async () => {
    fakeTimers();
    const { done, onState, controller } = setUpWith({ pollMs: 1000 }, []);
    controller.abort();
    await done;

    await vi.advanceTimersByTimeAsync(2000);

    expect(onState).not.toHaveBeenCalled();
  });
});
