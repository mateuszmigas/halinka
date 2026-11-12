import { describe, expect, it, vi } from "vitest";

import type { Repositories } from "./db/repositories";
import { RunBus } from "./runBus";

describe("RunBus", () => {
  it("logs a failed read of the queued runs instead of a rejection", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("no database");
    const repositories = {
      workflowRun: { listQueuedIdsByRunner: () => Promise.reject(failure) },
    } as unknown as Repositories;

    await new RunBus().notifyQueuedRuns(repositories, 1);

    expect(logged).toHaveBeenCalledWith(failure);
  });

  it("is idle after the notification of the queued runs", async () => {
    const read = Promise.withResolvers<{ id: number }[]>();
    const repositories = {
      workflowRun: { listQueuedIds: () => read.promise },
    } as unknown as Repositories;
    const bus = new RunBus();
    const notified = vi.fn();
    bus.subscribe(7, notified);
    void bus.notifyQueuedRuns(repositories);

    const idle = bus.idle();
    read.resolve([{ id: 7 }]);
    await idle;

    expect(notified).toHaveBeenCalledWith("state");
  });
});
