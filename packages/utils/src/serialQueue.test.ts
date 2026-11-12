import { describe, expect, it } from "vitest";

import { SerialQueue } from "./serialQueue";

describe("SerialQueue", () => {
  it("starts a task after the earlier task ends", async () => {
    const queue = new SerialQueue();
    const first = Promise.withResolvers<void>();
    const started: string[] = [];
    void queue.run(async () => {
      started.push("first");
      await first.promise;
    });

    const second = queue.run(async () => {
      started.push("second");
    });
    await Promise.resolve();

    expect(started).toEqual(["first"]);
    first.resolve();
    await second;
    expect(started).toEqual(["first", "second"]);
  });

  it("runs the next task after a task fails", async () => {
    const queue = new SerialQueue();
    const failed = queue.run(() => Promise.reject(new Error("failed")));

    const next = queue.run(() => Promise.resolve("next"));

    await expect(failed).rejects.toThrow("failed");
    expect(await next).toBe("next");
  });
});
