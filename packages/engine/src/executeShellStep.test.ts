import { fakeTimers } from "@halinka/utils/testing";
import { describe, expect, it, vi } from "vitest";

import { claimedRun, type FakeControlPlane, masking, setUpRun } from "./testing";

describe("executeShellStep", () => {
  it("commits the changes of a shell step in its checkpoint", async () => {
    const { plane, execute } = setUpRun();

    await execute(claimedRun(["generate"]));

    expect(plane.finished[0]?.result.checkpoint).toMatchObject({ before: "sha-0", after: "sha-1" });
  });

  it("commits the changes of a failed shell step", async () => {
    const { plane, execute } = setUpRun();

    expect(await execute(claimedRun(["fail after generate"]))).toBe("failed");

    expect(plane.finished[0]?.result.checkpoint).toMatchObject({ before: "sha-0", after: "sha-1" });
  });

  it("fails the step when its command cannot start", async () => {
    const { plane, execute } = setUpRun();

    expect(await execute(claimedRun(["missing"]))).toBe("failed");

    expect(plane.calls).toContain("finishAttempt 11 failed undefined failed");
    expect(plane.lastEvent()).toMatchObject({
      kind: "attempt_finished",
      payload: { status: "failed", error: "spawn sh ENOENT" },
    });
  });

  it.each([
    [true, true],
    [false, []],
    [["registry.npmjs.org"], ["registry.npmjs.org"]],
    [undefined, []],
  ])("gives a shell step with network %j the network %j", async (network, expected) => {
    const { sandbox, execute } = setUpRun();

    await execute(claimedRun([{ id: "build", type: "shell", run: "build", network }]));

    expect(sandbox.scriptNetworks).toEqual([["build", expected]]);
  });

  it("gives a shell step the last 10 lines of its output as its summary", async () => {
    const { plane, execute } = setUpRun();
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);

    await execute(claimedRun([lines.join("\n")]));

    expect(plane.finished[0]?.stepResult?.summary).toBe(lines.slice(2).join("\n"));
  });

  it("keeps stdout and stderr in arrival order in the summary of a shell step", async () => {
    const { plane, execute } = setUpRun();

    await execute(claimedRun(["mixed"]));

    expect(plane.finished[0]?.stepResult?.summary).toBe("out 1\nerr 1\nout 2");
  });

  const outputOf = (plane: FakeControlPlane) =>
    plane
      .events()
      .flatMap(({ kind, payload }) => (kind === "output" ? [payload.text] : []))
      .join("");

  it("masks a lent value that two output chunks split in the output", async () => {
    const { plane, execute } = setUpRun(undefined, masking("sk-lent-value-1"));

    await execute(claimedRun(["split a lent value"]));

    expect(outputOf(plane)).toBe("token *** done\n");
  });

  it("masks a lent value that two output chunks split in the step summary", async () => {
    const { plane, execute } = setUpRun(undefined, masking("sk-lent-value-1"));

    await execute(claimedRun(["split a lent value"]));

    expect(plane.finished[0]?.stepResult?.summary).toBe("token *** done");
  });

  it("gives the held output when the command fails", async () => {
    const { plane, execute } = setUpRun(undefined, masking("sk-lent-value-1"));

    await execute(claimedRun(["crash in a lent value"]));

    expect(outputOf(plane)).toBe("token sk-lent");
  });

  it("sends the first and the last 256 KiB of a long output, and the cut between them", async () => {
    const { plane, execute } = setUpRun();

    await execute(claimedRun(["flood"]));

    const output = plane
      .events()
      .flatMap(({ kind, payload }) =>
        kind === "output"
          ? [`${payload.text.length}`]
          : kind === "output_cut"
            ? [`cut ${payload.length}`]
            : [],
      );
    const part = Array<string>(4).fill("65536");
    expect(output).toEqual([...part, "cut 131072", ...part]);
  });

  it("fails the step when the script runs longer than the timeout", async () => {
    fakeTimers(["setTimeout", "clearTimeout"]);
    const { plane, sandbox, execute } = setUpRun();

    const result = execute(claimedRun([{ id: "s1", type: "shell", run: "hang", timeout: "10m" }]));
    await sandbox.hanging;
    await vi.advanceTimersByTimeAsync(600_000);

    expect(await result).toBe("failed");
    expect(plane.finished[0]?.stepResult).toEqual({
      status: "failed",
      summary: "The step timed out after 10m.",
    });
  });

  it("commits a checkpoint when the script times out", async () => {
    fakeTimers(["setTimeout", "clearTimeout"]);
    const { plane, sandbox, execute } = setUpRun();

    const result = execute(claimedRun([{ id: "s1", type: "shell", run: "hang", timeout: "10m" }]));
    await sandbox.hanging;
    await vi.advanceTimersByTimeAsync(600_000);
    await result;

    expect(plane.finished[0]?.result.checkpoint).toMatchObject({ before: "sha-0" });
  });
});
