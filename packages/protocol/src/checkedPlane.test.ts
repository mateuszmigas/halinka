import { describe, expect, it } from "vitest";

import { checkedPlane, controlPlaneMethods } from "./checkedPlane";
import type { ControlPlane } from "./controlPlane";
import { leaseOf, testSyncRequest } from "./testing";

const lease = leaseOf(1);

const setUp = () => {
  const calls: unknown[][] = [];
  const plane = Object.fromEntries(
    controlPlaneMethods.map((name) => [name, async (...args: unknown[]) => calls.push(args)]),
  ) as unknown as ControlPlane;
  return { plane: checkedPlane(plane), calls };
};

describe("checkedPlane", () => {
  it.each<[string, (plane: ControlPlane) => Promise<unknown>]>([
    [
      "an unknown sandbox kind",
      (plane) => plane.sync({ ...testSyncRequest, capabilities: { sandboxKind: "vm" } as never }),
    ],
    [
      "capabilities without a build",
      (plane) =>
        plane.sync({
          ...testSyncRequest,
          capabilities: { sandboxKind: "worktree", agentsOnPath: [] } as never,
        }),
    ],
    [
      "an event without its fields",
      (plane) =>
        plane.appendEvents(lease, {
          batchId: "b1",
          events: [{ kind: "output", payload: { stepId: "build" } } as never],
        }),
    ],
    ["no questions", (plane) => plane.askQuestion(lease, 1, [])],
    [
      "an unknown sandbox state",
      (plane) =>
        plane.reportSandbox({ workflowRunId: 1, generation: 2, observed: "gone" as never }),
    ],
    ["a run error that is not text", (plane) => plane.finishRun(lease, "failed", {} as never)],
    [
      "an extra argument",
      (plane) => (plane.startAttempt as (...args: unknown[]) => Promise<unknown>)(lease, 1, "x"),
    ],
  ])("refuses a call with %s before the plane gets it", async (_, call) => {
    const { plane, calls } = setUp();

    await expect(call(plane)).rejects.toMatchObject({ code: "invalid_input" });
    expect(calls).toEqual([]);
  });

  it("gives the plane a null argument as undefined", async () => {
    const { plane, calls } = setUp();

    await plane.startStep(lease, "build", null as never);

    expect(calls).toEqual([[lease, "build", undefined]]);
  });
});
