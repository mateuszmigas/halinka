import type { ChildProcess } from "node:child_process";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { forwardStopSignals, stopOnSignals } from "./signals";

const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const before = new Map(signals.map((signal) => [signal, process.listeners(signal)]));

const setUp = (stop: () => Promise<void>) => {
  onTestFinished(() => {
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (!before.get(signal)?.includes(listener)) process.off(signal, listener);
      }
    }
  });
  stopOnSignals(stop);
};

const fakeChild = () => ({ kill: vi.fn() });

describe("signals", () => {
  it.each(signals)("stops the runs on %s", (signal) => {
    const stop = vi.fn(async () => {});
    setUp(stop);

    process.emit(signal);

    expect(stop).toHaveBeenCalledOnce();
  });

  // Without a listener, Node ends the process at the signal.
  it("stops once and keeps its listener when a second signal arrives during the stop", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = vi.fn(() => new Promise<void>(() => {}));
    setUp(stop);

    process.emit("SIGINT");
    process.emit("SIGINT");

    expect(stop).toHaveBeenCalledOnce();
    expect(process.listenerCount("SIGINT")).toBe((before.get("SIGINT")?.length ?? 0) + 1);
    expect(error).toHaveBeenCalledOnce();
  });

  it("tells the user to wait at a later signal", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    setUp(() => new Promise<void>(() => {}));
    process.emit("SIGTERM");

    process.emit("SIGINT");

    expect(log).toHaveBeenCalledWith("halinka is stopping the runs. Wait for the stop to end.");
  });

  it("leaves the signals to Node after the stop", async () => {
    const count = process.listenerCount("SIGINT");
    setUp(async () => {});

    process.emit("SIGINT");

    await vi.waitFor(() => expect(process.listenerCount("SIGINT")).toBe(count));
  });

  it.each(signals)("gives %s to the child", (signal) => {
    const child = fakeChild();
    const endForward = forwardStopSignals(child as unknown as ChildProcess);
    onTestFinished(endForward);

    process.emit(signal);

    expect(child.kill).toHaveBeenCalledWith(signal);
  });

  it("gives no signal to the child after the forward ends", () => {
    const child = fakeChild();
    const before = process.listenerCount("SIGTERM");
    forwardStopSignals(child as unknown as ChildProcess)();

    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});
