import { connectionClosed, type ControlPlane, type RunCall, unavailable } from "@halinka/protocol";
import { leaseOf, testSyncRequest } from "@halinka/protocol/testing";
import { describe, expect, it, vi } from "vitest";

import { LentValues } from "./lentValues";
import { runnerPlane } from "./runnerPlane";
import { fakePlane } from "./testing";

const lease = leaseOf(1);

// `startStep` fails with the given errors first, then gives 7. Only `startStep` is used.
const planeFailing = (...errors: Error[]) => {
  const calls: RunCall[] = [];
  const startStep = async (call: RunCall) => {
    calls.push(call);
    const error = errors.shift();
    if (error) throw error;
    return 7;
  };
  return { plane: fakePlane({ startStep }), calls };
};

const repeating = (plane: ControlPlane, signal = new AbortController().signal) =>
  runnerPlane(plane, new LentValues(), signal);

describe("runnerPlane", () => {
  it("sends the arguments with the lent values masked", async () => {
    const finishRun = vi.fn<ControlPlane["finishRun"]>().mockResolvedValue(undefined);
    const lent = new LentValues();
    lent.add("API_KEY", "sk-secret-1");
    const plane = runnerPlane(fakePlane({ finishRun }), lent, new AbortController().signal);

    await plane.finishRun(lease, "failed", "npm: 401 for sk-secret-1");

    expect(finishRun.mock.calls[0]?.[2]).toBe("npm: 401 for ***");
  });

  it("masks a value lent during the backoff in the repeat", async () => {
    const lent = new LentValues();
    const finishRun = vi
      .fn<ControlPlane["finishRun"]>()
      .mockImplementationOnce(async () => {
        lent.add("API_KEY", "sk-secret-1");
        throw connectionClosed();
      })
      .mockResolvedValue(undefined);
    const plane = runnerPlane(fakePlane({ finishRun }), lent, new AbortController().signal);

    await plane.finishRun(lease, "failed", "npm: 401 for sk-secret-1");

    expect(finishRun.mock.calls[1]?.[2]).toBe("npm: 401 for ***");
  });

  it("sends the result of an agent test again after a closed connection", async () => {
    const finishAgentTest = vi
      .fn<ControlPlane["finishAgentTest"]>()
      .mockRejectedValueOnce(connectionClosed())
      .mockResolvedValue(undefined);
    const plane = fakePlane({ finishAgentTest });

    await repeating(plane).finishAgentTest("token-1", { capabilities: {} });

    expect(finishAgentTest.mock.calls).toEqual([
      ["token-1", { capabilities: {} }],
      ["token-1", { capabilities: {} }],
    ]);
  });

  it("does not send a sync again after a closed connection", async () => {
    const sync = vi.fn<ControlPlane["sync"]>().mockRejectedValue(connectionClosed());
    const plane = fakePlane({ sync });

    await expect(repeating(plane).sync(testSyncRequest)).rejects.toMatchObject({
      code: "connection_closed",
    });
    expect(sync).toHaveBeenCalledOnce();
  });

  it("sends a write again under the same call id after a closed connection", async () => {
    const { plane, calls } = planeFailing(connectionClosed(), connectionClosed());

    await repeating(plane).startStep(lease, "build");

    expect(calls.map(({ callId }) => callId)).toEqual(Array(3).fill(calls[0]?.callId));
  });

  it("sends a write again when the server has no database", async () => {
    const { plane, calls } = planeFailing(unavailable("The database is not available"));

    await repeating(plane).startStep(lease, "build");

    expect(calls).toHaveLength(2);
  });

  it("gives the result of the write that the server answered", async () => {
    const { plane } = planeFailing(connectionClosed());

    expect(await repeating(plane).startStep(lease, "build")).toBe(7);
  });

  it("gives each write its own call id", async () => {
    const { plane, calls } = planeFailing();
    const writer = repeating(plane);

    await writer.startStep(lease, "build");
    await writer.startStep(lease, "test");

    expect(calls[0]?.callId).not.toBe(calls[1]?.callId);
  });

  it("does not send a write again after another error", async () => {
    const { plane, calls } = planeFailing(new Error("No database"));

    await expect(repeating(plane).startStep(lease, "build")).rejects.toThrow("No database");
    expect(calls).toHaveLength(1);
  });

  it("gives the last transient error when the signal aborts", async () => {
    const stopping = new AbortController();
    const { plane, calls } = planeFailing(...Array.from({ length: 100 }, () => connectionClosed()));
    const writing = repeating(plane, stopping.signal).startStep(lease, "build");
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    stopping.abort();

    await expect(writing).rejects.toMatchObject({ code: "connection_closed" });
  });
});
