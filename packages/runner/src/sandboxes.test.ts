import type {
  SandboxObservation,
  SandboxReport,
  SandboxSpec,
  SandboxTarget,
} from "@halinka/protocol";
import type { ContainerState, DevcontainerStatus } from "@halinka/sandbox/devcontainer";
import { fakeTimers } from "@halinka/utils/testing";
import { describe, expect, it, type Mock, vi } from "vitest";

import { type SandboxHost, Sandboxes } from "./sandboxes";

const targetOf = (spec: SandboxSpec, generation = 1): SandboxTarget => ({
  workflowRunId: 1,
  kind: "worktree",
  repoPath: "/code/app",
  baseSha: "abc",
  definitionSha: "abc",
  spec,
  generation,
});

const targetsOf = (...workflowRunIds: number[]) =>
  workflowRunIds.map((workflowRunId) => ({ ...targetOf("stopped"), workflowRunId }));

const containerOf = (workflowRunId: number, spec: SandboxSpec = "running"): SandboxTarget => ({
  ...targetOf(spec),
  workflowRunId,
  kind: "devcontainer",
});

const appliedRuns = (host: { apply: Mock<SandboxHost["apply"]> }) =>
  host.apply.mock.calls.map(([{ workflowRunId }]) => workflowRunId);

type StatusOptions = { isActive?: boolean };

const statusOf = (
  main: ContainerState,
  { isActive = main === "running" }: StatusOptions = {},
): DevcontainerStatus => ({
  main,
  isActive,
});

const setUp = ({ lockedRuns = [] as number[], maxApplying = 4, sweepMs = 60_000 } = {}) => {
  const plane = { reportSandbox: vi.fn(async (_report: SandboxReport) => {}) };
  const reports = () => plane.reportSandbox.mock.calls.map(([report]) => report);
  const containers = new Map<number, DevcontainerStatus>();
  const host = {
    apply: vi.fn<SandboxHost["apply"]>(async () => ({ observed: "absent" })),
    inspectContainers: vi.fn<SandboxHost["inspectContainers"]>(async () => containers),
  };
  const release = vi.fn(async () => {});
  const locks = {
    tryTake: vi.fn(async (workflowRunId: number) =>
      lockedRuns.includes(workflowRunId) ? undefined : release,
    ),
  };
  const sandboxes = new Sandboxes({ plane, host, locks, maxApplying, sweepMs });
  const applied = async (...targets: SandboxTarget[]) => {
    sandboxes.apply(targets);
    await sandboxes.idle();
  };
  const swept = async (...targets: SandboxTarget[]) => {
    sandboxes.sweep(targets);
    await sandboxes.idle();
  };
  return { reports, plane, host, containers, release, sandboxes, applied, swept };
};

describe("Sandboxes", () => {
  it("reports what the host finds", async () => {
    const { reports, applied } = setUp();

    await applied(targetOf("stopped"));

    expect(reports()).toEqual([{ workflowRunId: 1, generation: 1, observed: "absent" }]);
  });

  it("reports each apply, also an observation that did not change", async () => {
    const { reports, applied } = setUp();
    await applied(targetOf("stopped"));

    await applied(targetOf("stopped"));

    expect(reports()).toHaveLength(2);
  });

  it("reports nothing of an apply that a stop aborts", async () => {
    const { reports, host, sandboxes } = setUp();
    host.apply.mockImplementationOnce(
      (_, signal) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    );
    sandboxes.apply([targetOf("running")]);
    await vi.waitFor(() => expect(host.apply).toHaveBeenCalled());

    await sandboxes.stop();

    expect(reports()).toEqual([]);
  });

  it("applies no more runs at a time than its limit", async () => {
    const { host, sandboxes } = setUp({ maxApplying: 1 });
    const applying = Promise.withResolvers<SandboxObservation>();
    host.apply.mockReturnValueOnce(applying.promise);

    sandboxes.apply([targetOf("stopped"), { ...targetOf("stopped"), workflowRunId: 2 }]);
    applying.resolve({ observed: "absent" });
    await sandboxes.idle();

    expect(host.apply).toHaveBeenCalledOnce();
  });

  it("finds a sweep due at the start", () => {
    const { sandboxes } = setUp();

    expect(sandboxes.isSweepDue()).toBe(true);
  });

  it("finds a sweep not due again before the interval ends", async () => {
    const { sandboxes, swept } = setUp();

    await swept(containerOf(1));

    expect(sandboxes.isSweepDue()).toBe(false);
  });

  it("finds a sweep due one interval after the last sweep", async () => {
    fakeTimers(["Date"]);
    const { sandboxes, swept } = setUp({ sweepMs: 1000 });
    await swept(containerOf(1));

    vi.advanceTimersByTime(1000);

    expect(sandboxes.isSweepDue()).toBe(true);
  });

  it("finds a sweep not due while it inspects the containers", () => {
    const { host, sandboxes } = setUp();
    host.inspectContainers.mockReturnValueOnce(new Promise(() => {}));

    sandboxes.sweep([containerOf(1)]);

    expect(sandboxes.isSweepDue()).toBe(false);
  });

  it("inspects the containers of all runs in one call at a sweep", async () => {
    const { host, swept } = setUp();

    await swept(containerOf(1), containerOf(2), ...targetsOf(3));

    expect(host.inspectContainers.mock.calls).toEqual([[[1, 2]]]);
  });

  it("applies at a sweep only the containers that differ from their spec", async () => {
    const { host, containers, swept } = setUp({ maxApplying: 8 });
    containers
      .set(1, statusOf("running"))
      .set(2, statusOf("stopped"))
      .set(3, statusOf("running"))
      .set(4, statusOf("stopped"))
      .set(7, statusOf("stopped", { isActive: true }))
      .set(8, statusOf("absent", { isActive: true }));

    await swept(
      containerOf(1),
      containerOf(2),
      containerOf(3, "stopped"),
      containerOf(4, "stopped"),
      containerOf(5),
      containerOf(6, "stopped"),
      containerOf(7),
      containerOf(8, "stopped"),
    );

    expect(appliedRuns(host)).toEqual([2, 3, 5, 7, 8]);
  });

  it("applies at a sweep each spec that removes a sandbox", async () => {
    const { host, swept } = setUp();

    await swept(containerOf(1, "destroyed"), { ...targetOf("destroyed"), workflowRunId: 2 });

    expect(appliedRuns(host)).toEqual([1, 2]);
  });

  it("applies at a sweep each worktree run without the limit and without a container inspect", async () => {
    const { host, sandboxes, swept } = setUp({ maxApplying: 1 });

    await swept(targetOf("running"), ...targetsOf(2, 3));

    expect(appliedRuns(host)).toEqual([1, 2, 3]);
    expect(host.inspectContainers).not.toHaveBeenCalled();
    expect(sandboxes.isSweepDue()).toBe(false);
  });

  it("leaves no slot for a list while the worktree runs of a sweep exceed the limit", async () => {
    const { host, sandboxes } = setUp({ maxApplying: 1 });
    const applying = Promise.withResolvers<SandboxObservation>();
    host.apply.mockReturnValue(applying.promise);
    sandboxes.sweep(targetsOf(1, 2));
    await vi.waitFor(() => expect(host.apply).toHaveBeenCalledTimes(2));

    sandboxes.apply(targetsOf(3, 4));

    applying.resolve({ observed: "stopped" });
    await sandboxes.idle();
    expect(appliedRuns(host)).toEqual([1, 2]);
  });

  it("keeps the limit for the containers when the worktree runs of a sweep fill it", async () => {
    const { host, swept } = setUp({ maxApplying: 1 });

    await swept(...targetsOf(1, 2), containerOf(3), containerOf(4));

    expect(appliedRuns(host)).toEqual([3, 1, 2]);
  });

  it("gives the slot of a locked run to the next run of a sweep", async () => {
    const { host, sandboxes, swept } = setUp({ lockedRuns: [1, 2], maxApplying: 2 });

    await swept(containerOf(1), containerOf(2), containerOf(3));

    expect(appliedRuns(host)).toEqual([3]);
    expect(sandboxes.isSweepDue()).toBe(false);
  });

  it("continues a sweep at the next free slot when more runs differ than its limit", async () => {
    const { host, sandboxes, swept } = setUp({ maxApplying: 1 });

    await swept(containerOf(1), containerOf(2));

    expect(appliedRuns(host)).toEqual([1]);
    expect(sandboxes.isSweepDue()).toBe(true);
  });

  it("does not continue a sweep while no slot is free", async () => {
    const { host, sandboxes } = setUp({ maxApplying: 1 });
    const applying = Promise.withResolvers<SandboxObservation>();
    host.apply.mockReturnValueOnce(applying.promise);
    sandboxes.sweep([containerOf(1), containerOf(2)]);
    await vi.waitFor(() => expect(host.apply).toHaveBeenCalled());

    const isDue = sandboxes.isSweepDue();

    applying.resolve({ observed: "running" });
    await sandboxes.idle();
    expect(isDue).toBe(false);
  });

  it("does not continue a sweep for a run that waits for its retry", async () => {
    const { host, sandboxes, swept } = setUp({ maxApplying: 1 });
    host.apply.mockRejectedValueOnce(new Error("Disk full"));
    await swept(containerOf(1), containerOf(2));

    await swept(containerOf(1), containerOf(2));

    expect(appliedRuns(host)).toEqual([1, 2]);
    expect(sandboxes.isSweepDue()).toBe(false);
  });

  it("logs a failed inspect of a sweep and applies nothing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { host, swept } = setUp();
    host.inspectContainers.mockRejectedValueOnce(new Error("Docker is not running"));

    await swept(containerOf(1));

    expect(host.apply).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
  });

  it("reports the error of a failed apply", async () => {
    const { reports, host, applied } = setUp();
    host.apply.mockRejectedValueOnce(new Error("Disk full"));

    await applied(targetOf("destroyed"));

    expect(reports()).toEqual([{ workflowRunId: 1, generation: 1, error: "Disk full" }]);
  });

  it("releases the lock after a failed apply", async () => {
    const { release, host, applied } = setUp();
    host.apply.mockRejectedValueOnce(new Error("Disk full"));

    await applied(targetOf("destroyed"));

    expect(release).toHaveBeenCalledOnce();
  });

  it("does not apply a failed generation again before its retry time", async () => {
    const { host, applied } = setUp();
    host.apply.mockRejectedValueOnce(new Error("Disk full"));
    await applied(targetOf("destroyed"));

    await applied(targetOf("destroyed"));

    expect(host.apply).toHaveBeenCalledOnce();
  });

  it("applies a failed generation again after its retry time", async () => {
    fakeTimers(["Date"]);
    const { host, applied } = setUp();
    host.apply.mockRejectedValueOnce(new Error("Disk full"));
    await applied(targetOf("destroyed"));

    vi.setSystemTime(Date.now() + 5000);
    await applied(targetOf("destroyed"));

    expect(host.apply).toHaveBeenCalledTimes(2);
  });

  it("applies the spec again after a report that failed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { plane, host, applied } = setUp();
    plane.reportSandbox.mockRejectedValueOnce(new Error("Connection lost"));
    await applied(targetOf("destroyed"));

    await applied(targetOf("destroyed"));

    expect(host.apply).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledOnce();
  });

  it("applies a new generation at once after a failure", async () => {
    const { host, applied } = setUp();
    host.apply.mockRejectedValueOnce(new Error("Disk full"));
    await applied(targetOf("destroyed"));

    await applied(targetOf("destroyed", 2));

    expect(host.apply).toHaveBeenCalledTimes(2);
  });

  it("leaves a run whose lock another holder has", async () => {
    const { reports, host, applied } = setUp({ lockedRuns: [1] });

    await applied(targetOf("destroyed"));

    expect(host.apply).not.toHaveBeenCalled();
    expect(reports()).toEqual([]);
  });

  it("applies one spec of a run at a time", async () => {
    const { host, sandboxes, applied } = setUp();
    const removed = Promise.withResolvers<SandboxObservation>();
    host.apply.mockReturnValueOnce(removed.promise);
    sandboxes.apply([targetOf("destroyed")]);

    sandboxes.apply([targetOf("destroyed")]);
    removed.resolve({ observed: "absent" });
    await applied();

    expect(host.apply).toHaveBeenCalledOnce();
  });
});
