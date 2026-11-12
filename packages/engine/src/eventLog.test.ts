import { type EventBatch, invalidInput, type RunEvent } from "@halinka/protocol";
import { leaseOf } from "@halinka/protocol/testing";
import { fakeTimers } from "@halinka/utils/testing";
import { describe, expect, it, vi } from "vitest";

import { EventLog } from "./eventLog";

const output = (text: string): RunEvent => ({
  kind: "output",
  payload: { stepId: "s1", attemptId: 1, stream: "stdout", text },
});

const setUp = (refuse: (batch: EventBatch) => Error | undefined = () => undefined) => {
  const batches: EventBatch[] = [];
  const log = new EventLog(
    {
      appendEvents: async (_, batch) => {
        const refusal = refuse(batch);
        if (refusal) throw refusal;
        batches.push(batch);
      },
    },
    leaseOf(1),
  );
  const append = (text: string) => log.emit(output(text));
  const sent = () =>
    batches.map(({ events }) =>
      events.map(({ payload }) => ("text" in payload ? payload.text : "")),
    );
  return { log, append, sent };
};

describe("EventLog", () => {
  it("merges an event into the last pending event", async () => {
    const { log, append, sent } = setUp();

    append("a");
    append("b");
    await log.flush();

    expect(sent()).toEqual([["ab"]]);
  });

  it("sends a merged event when the flush time ends", async () => {
    fakeTimers();
    const { append, sent } = setUp();

    append("a");
    append("b");
    await vi.advanceTimersByTimeAsync(200);

    expect(sent()).toEqual([["ab"]]);
  });

  it("keeps an event separate when the merge gives no event", async () => {
    const { log, append, sent } = setUp();

    log.emit({ kind: "agent_prompt", payload: { stepId: "s1", attemptId: 1, text: "a" } });
    append("b");
    await log.flush();

    expect(sent()).toEqual([["a", "b"]]);
  });

  it("does not merge an event into a batch that it sent", async () => {
    const { log, append, sent } = setUp();

    append("a");
    await log.flush();
    append("b");
    await log.flush();

    expect(sent()).toEqual([["a"], ["b"]]);
  });

  it("rejects each later flush when the server refuses a batch", async () => {
    const refusals = [invalidInput("The batch is not valid")];
    const { log, append, sent } = setUp(() => refusals.shift());

    append("a");
    await expect(log.flush()).rejects.toThrow("The server refused the events of the run");
    append("b");
    await expect(log.flush()).rejects.toThrow("The server refused the events of the run");

    expect(sent()).toEqual([]);
  });

  it("sends the batch at once when its events reach 1 MiB", async () => {
    fakeTimers();
    const { append, sent } = setUp();

    append("a".repeat(600 * 1024));
    append("b".repeat(600 * 1024));
    await vi.advanceTimersByTimeAsync(0);

    expect(sent()).toHaveLength(1);
  });

  it("drops an event larger than 4 MiB and logs it", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { log, append, sent } = setUp();

    append("x".repeat(4 * 1024 * 1024));
    append("small");
    await log.flush();

    expect(sent()).toEqual([["small"]]);
    expect(errorLog).toHaveBeenCalledOnce();
  });
});
