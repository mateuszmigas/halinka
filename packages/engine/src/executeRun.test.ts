import {
  connectionClosed,
  invalidInput,
  leaseLost,
  type RecordedStep,
  unavailable,
} from "@halinka/protocol";
import { fakeTimers } from "@halinka/utils/testing";
import type { LeafStep } from "@halinka/workflow";
import { describe, expect, it, vi } from "vitest";

import { agentStep, budgeted, buildStep, claimedRun, loopStep, masking, setUpRun } from "./testing";

describe("executeRun", () => {
  it("succeeds when each step succeeds", async () => {
    const { execute } = setUpRun();

    expect(await execute(claimedRun(["build", "test"]))).toBe("succeeded");
  });

  it("runs the steps in order", async () => {
    const { plane, sandbox, execute } = setUpRun();

    await execute(claimedRun(["build", "test"]));

    expect(sandbox.ran).toEqual(["build", "test"]);
    expect(plane.calls).toEqual([
      "startStep s1",
      "startAttempt 10",
      "finishAttempt 11 succeeded 0 succeeded",
      "startStep s2",
      "startAttempt 12",
      "finishAttempt 13 succeeded 0 succeeded",
    ]);
  });

  it("sends the events of every step before it returns", async () => {
    const { plane, execute } = setUpRun();

    await execute(claimedRun(["build", "test"]));

    expect(plane.eventKinds()).toEqual([
      "attempt_started",
      "output",
      "checkpoint",
      "attempt_finished",
      "attempt_started",
      "output",
      "checkpoint",
      "attempt_finished",
    ]);
  });

  it("fails at the first step that fails", async () => {
    const { plane, execute } = setUpRun();

    expect(await execute(claimedRun(["fail", "test"]))).toBe("failed");

    expect(plane.calls).toContain("finishAttempt 11 failed 1 failed");
  });

  it("does not run the steps after a failed step", async () => {
    const { sandbox, execute } = setUpRun();

    await execute(claimedRun(["fail", "test"]));

    expect(sandbox.ran).toEqual(["fail"]);
  });

  const interrupted: RecordedStep[] = [
    { stepRunId: 1, stepId: "s1", status: "succeeded", failedAttempts: 0 },
    { stepRunId: 2, stepId: "s2", status: "running", failedAttempts: 0 },
  ];

  it("skips the finished steps", async () => {
    const { sandbox, execute } = setUpRun();

    expect(await execute(claimedRun(["build", "test", "lint"], interrupted))).toBe("succeeded");

    expect(sandbox.ran).toEqual(["test", "lint"]);
  });

  it("continues an interrupted step in a new attempt", async () => {
    const { plane, execute } = setUpRun();

    await execute(claimedRun(["build", "test", "lint"], interrupted));

    expect(plane.calls.slice(0, 3)).toEqual([
      "startAttempt 2",
      "finishAttempt 10 succeeded 0 succeeded",
      "startStep s3",
    ]);
  });

  const conditional = (id: string, run: string, condition: string): LeafStep => ({
    id,
    type: "shell",
    run,
    if: condition,
  });

  const skippedSecond = [
    "build",
    conditional("s2", "deploy", "${{ steps.s1.status == 'skipped' }}"),
    "test",
  ];

  it("skips a step whose if is false", async () => {
    const { plane, execute } = setUpRun();

    expect(await execute(claimedRun(skippedSecond))).toBe("succeeded");

    expect(plane.calls).toContain("finishStep 12 skipped");
  });

  it("runs the step after a skipped step", async () => {
    const { sandbox, execute } = setUpRun();

    await execute(claimedRun(skippedSecond));

    expect(sandbox.ran).toEqual(["build", "test"]);
  });

  it("runs a step whose if is true", async () => {
    const { sandbox, execute } = setUpRun();
    const steps = ["build", conditional("s2", "deploy", "${{ steps.s1.status == 'succeeded' }}")];

    await execute(claimedRun(steps));

    expect(sandbox.ran).toEqual(["build", "deploy"]);
  });

  it("fills in the agent prompt from the results of earlier steps", async () => {
    const { plane, execute } = setUpRun();
    const steps = ["build", agentStep({ prompt: "Fix ${{ steps.s1.summary }}" })];

    await execute(claimedRun(steps));

    expect(plane.events().find(({ kind }) => kind === "agent_prompt")).toMatchObject({
      payload: { text: expect.stringMatching(/^Fix build\n/) },
    });
  });

  it("fills in the agent prompt from the masked results of earlier steps", async () => {
    const { plane, execute } = setUpRun(undefined, masking("build"));
    const steps = ["build", agentStep({ prompt: "Fix ${{ steps.s1.summary }}" })];

    await execute(claimedRun(steps));

    expect(plane.events().find(({ kind }) => kind === "agent_prompt")).toMatchObject({
      payload: { text: expect.stringMatching(/^Fix \*\*\*\n/) },
    });
  });

  it("fills in the approval message from the results that the run recorded before", async () => {
    const { plane, inbox, execute } = setUpRun();
    const recorded: RecordedStep[] = [
      { stepRunId: 1, stepId: "a1", status: "succeeded", outcome: "approve", failedAttempts: 0 },
    ];
    const step: LeafStep = {
      id: "approve",
      type: "approval",
      message: "The review gave ${{ steps.a1.outcome }}",
    };
    inbox.decide(7, "approve");

    await execute(claimedRun([agentStep({ prompt: "Review" }), step], recorded));

    expect(plane.calls).toContain("openApproval 10 The review gave approve");
  });

  it("fails the agent step without an attempt when its prompt reads a value that is not set", async () => {
    const { plane, execute } = setUpRun();
    const steps = ["build", agentStep({ prompt: "Fix ${{ steps.s1.outcome }}" })];

    expect(await execute(claimedRun(steps))).toBe("failed");

    expect(plane.calls).toContain("finishStep 12 failed");
    expect(plane.calls).not.toContain("startAttempt 12");
  });

  it("fails without a command when a recorded step failed", async () => {
    const { plane, sandbox, execute } = setUpRun();
    const recorded: RecordedStep[] = [
      { stepRunId: 1, stepId: "s1", status: "failed", failedAttempts: 0 },
    ];

    expect(await execute(claimedRun(["build", "test"], recorded))).toBe("failed");

    expect(sandbox.ran).toEqual([]);
    expect(plane.calls).toEqual([]);
  });

  const abortedInStep = async () => {
    const { plane, sandbox, controller, execute } = setUpRun();
    const result = execute(claimedRun(["hang", "test"]));
    await sandbox.hanging;
    controller.abort();
    return { plane, result: await result };
  };

  it("on abort, stops the step", async () => {
    const { result } = await abortedInStep();

    expect(result).toBe("aborted");
  });

  it("on abort, sends the events of the step", async () => {
    const { plane } = await abortedInStep();

    expect(plane.eventKinds()).toEqual(["attempt_started"]);
  });

  it("on abort, leaves the step run open", async () => {
    const { plane } = await abortedInStep();

    expect(plane.calls).toEqual(["startStep s1", "startAttempt 10"]);
  });

  it("returns at once when the signal is already aborted", async () => {
    const { plane, controller, execute } = setUpRun();
    controller.abort();

    expect(await execute(claimedRun(["build"]))).toBe("aborted");
    expect(plane.calls).toEqual([]);
  });

  it("sends a batch again under the same id until the server acknowledges it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const sent: string[] = [];
    const { execute } = setUpRun({
      appendEvents: async (_, { batchId }) => {
        sent.push(batchId);
        if (sent.length === 1) throw connectionClosed();
      },
    });

    expect(await execute(claimedRun(["build"]))).toBe("succeeded");

    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("the server did not store events"),
      connectionClosed(),
    );
  });

  const executedToLeaseLost = async () => {
    let sent = 0;
    const { plane, execute } = setUpRun({
      appendEvents: async () => {
        sent++;
        throw leaseLost(1);
      },
    });
    await expect(execute(claimedRun(["build", "test"]))).rejects.toMatchObject({
      code: "lease_lost",
    });
    return { plane, sent };
  };

  it("stops at lease_lost", async () => {
    const { plane } = await executedToLeaseLost();

    expect(plane.calls).not.toContain("startStep s2");
  });

  it("does not send the batch again at lease_lost", async () => {
    const { sent } = await executedToLeaseLost();

    expect(sent).toBe(1);
  });

  it("fails the run when the server refuses a batch", async () => {
    const { plane, execute } = setUpRun({
      appendEvents: async () => {
        throw invalidInput("The batch is not valid");
      },
    });

    await expect(execute(claimedRun(["build", "test"]))).rejects.toThrow(
      "The server refused the events of the run: The batch is not valid",
    );

    expect(plane.calls).not.toContain("startStep s2");
  });

  it("finishes a completed step, then returns aborted, when an abort comes while its events are not stored", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let sent = 0;
    const { plane, controller, execute } = setUpRun({
      appendEvents: async () => {
        sent++;
        throw unavailable("The database is not available");
      },
    });

    const result = execute(claimedRun(["build"]));
    await vi.waitFor(() => expect(sent).toBeGreaterThan(0));
    controller.abort();

    expect(await result).toBe("aborted");
    expect(plane.calls).toEqual([
      "startStep s1",
      "startAttempt 10",
      "finishAttempt 11 succeeded 0 succeeded",
    ]);
    expect(error).toHaveBeenCalledWith("Run 1: the last events were not stored in time");
  });

  it("gives the next step the outputs that Halinka adds to an agent step", async () => {
    const { plane, execute } = setUpRun();
    const outputs = ["commit", "session_id", "changed_files[0]"]
      .map((output) => `\${{ steps.a1.outputs.${output} }}`)
      .join(" ");

    await execute(
      claimedRun([agentStep({ prompt: "fix the bug" }), agentStep({ prompt: outputs, id: "a2" })]),
    );

    expect(plane.prompts()[1]).toMatch(/^sha-1 session-1 src\/app.ts\n/);
  });

  it("gives the next step the facts of the step run that the server returns", async () => {
    const { plane, execute } = setUpRun({
      finishAttempt: async () => ({
        commit: "sha-9",
        changedFiles: ["a.ts"],
        changedFileCount: 1500,
      }),
    });
    const outputs = "${{ steps.a1.outputs.changed_file_count }} ${{ steps.a1.outputs.commit }}";

    await execute(
      claimedRun([agentStep({ prompt: "fix the bug" }), agentStep({ prompt: outputs, id: "a2" })]),
    );

    expect(plane.prompts()[1]).toMatch(/^1500 sha-9\n/);
  });

  const loopRun: RecordedStep = {
    stepRunId: 1,
    stepId: "fix_loop",
    status: "running",
    failedAttempts: 0,
  };

  const earlierIteration = (stepId: string, usage: RecordedStep["usage"]): RecordedStep => ({
    stepRunId: 2,
    stepId,
    status: "succeeded",
    failedAttempts: 0,
    parent: { stepRunId: 1, iteration: 1 },
    ...(usage && { usage }),
  });

  const hangStep: LeafStep = { id: "s1", type: "shell", run: "hang" };

  it("runs the children in each iteration until until holds", async () => {
    const { plane, execute } = setUpRun();

    expect(await execute(claimedRun([loopStep([buildStep])]))).toBe("succeeded");

    expect(plane.calls).toEqual([
      "startStep fix_loop",
      "startStep build in 10.1",
      "startAttempt 11",
      "finishAttempt 12 succeeded 0 succeeded",
      "startStep build in 10.2",
      "startAttempt 13",
      "finishAttempt 14 succeeded 0 succeeded",
      "finishStep 10 succeeded",
    ]);
  });

  it("on resume, continues the loop in the next iteration", async () => {
    const { plane, execute } = setUpRun();

    const recorded = [loopRun, earlierIteration("build", undefined)];
    await execute(claimedRun([loopStep([buildStep])], recorded));

    expect(plane.calls[0]).toBe("startStep build in 1.2");
  });

  it("fails the child at the loop's max_cost_usd, without a question", async () => {
    const { plane, execute } = setUpRun();

    const loop = loopStep([agentStep({ prompt: "cost 3" })], { max_cost_usd: 2 });
    expect(await execute(claimedRun([loop]))).toBe("failed");

    expect(plane.calls.some((call) => call.startsWith("askHuman"))).toBe(false);
    expect(plane.finished[0]?.result).toMatchObject({
      status: "failed",
      summary: "The agent reached max_cost_usd ($2) of the loop `fix_loop`.",
    });
  });

  it("counts the cost of the recorded iterations toward the loop's max_cost_usd", async () => {
    const { plane, execute } = setUpRun();

    const recorded = [loopRun, earlierIteration("a1", { activeMs: 1000, costUsd: 1.5 })];
    const loop = loopStep([agentStep({ prompt: "cost 1" })], {
      max_cost_usd: 2,
      until: "${{ false }}",
    });
    await execute(claimedRun([loop], recorded));

    expect(plane.finished[0]?.result).toMatchObject({
      status: "failed",
      summary: "The agent reached max_cost_usd ($2) of the loop `fix_loop`.",
    });
  });

  it("ends the loop before the next child when the earlier iterations of the run used its max_cost_usd", async () => {
    const { plane, execute } = setUpRun();

    const loop = loopStep([agentStep({ prompt: "report cost 2" })], {
      max_cost_usd: 3,
      max_iterations: 3,
      until: "${{ false }}",
    });
    await execute(claimedRun([loop]));

    expect(plane.prompts()).toHaveLength(2);
    expect(plane.finishedSteps.at(-1)).toEqual({
      status: "failed",
      summary: "The child steps reached max_cost_usd ($3) of the loop `fix_loop`.",
    });
  });

  it("fails the step at the workflow's max_cost_usd", async () => {
    const { plane, execute } = setUpRun();

    const result = await execute(budgeted(claimedRun([agentStep({ prompt: "cost 3" })]), 2));

    expect(result).toBe("failed");
    expect(plane.finished[0]?.result).toMatchObject({
      summary: "The agent reached max_cost_usd ($2) of the workflow.",
    });
  });

  it("asks no person at the workflow's max_cost_usd", async () => {
    const { plane, execute } = setUpRun();

    await execute(budgeted(claimedRun([agentStep({ prompt: "cost 3" })]), 2));

    expect(plane.calls.some((call) => call.startsWith("askHuman"))).toBe(false);
  });

  it("counts the cost of the recorded steps toward the workflow's max_cost_usd", async () => {
    const { plane, execute } = setUpRun();
    const earlier: RecordedStep = {
      stepRunId: 5,
      stepId: "build",
      status: "succeeded",
      failedAttempts: 0,
      usage: { activeMs: 1, costUsd: 1.5 },
    };
    const steps = [
      { id: "build", type: "shell", run: "ls" } as const,
      agentStep({ prompt: "cost 1" }),
    ];

    await execute(budgeted(claimedRun(steps, [earlier]), 2));

    expect(plane.finished[0]?.result).toMatchObject({
      status: "failed",
      summary: "The agent reached max_cost_usd ($2) of the workflow.",
    });
  });

  it("fails an agent child at the loop's timeout, without a question", async () => {
    fakeTimers(["setTimeout", "clearTimeout"]);
    const { plane, agent, execute } = setUpRun();

    const result = execute(
      claimedRun([loopStep([agentStep({ prompt: "slow" })], { timeout: "1m" })]),
    );
    await agent.running;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await result).toBe("failed");
    expect(plane.finished[0]?.result).toMatchObject({
      status: "failed",
      summary: "The agent reached timeout (1m) of the loop `fix_loop`.",
    });
  });

  it("fails a shell child at the loop's timeout", async () => {
    fakeTimers(["setTimeout", "clearTimeout"]);
    const { plane, sandbox, execute } = setUpRun();

    const result = execute(claimedRun([loopStep([hangStep], { timeout: "10m" })]));
    await sandbox.hanging;
    await vi.advanceTimersByTimeAsync(600_000);

    expect(await result).toBe("failed");
    expect(plane.finished[0]?.stepResult).toEqual({
      status: "failed",
      summary: "The step reached timeout (10m) of the loop `fix_loop`.",
    });
  });

  it("gives a shell child the rest of the loop's timeout after the recorded iterations", async () => {
    fakeTimers(["setTimeout", "clearTimeout"]);
    const { plane, sandbox, execute } = setUpRun();

    const recorded = [loopRun, earlierIteration("s1", { activeMs: 540_000 })];
    const loop = loopStep([hangStep], { timeout: "10m", until: "${{ false }}" });
    const result = execute(claimedRun([loop], recorded));
    await sandbox.hanging;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await result).toBe("failed");
    expect(plane.finished[0]?.stepResult?.summary).toBe(
      "The step reached timeout (10m) of the loop `fix_loop`.",
    );
  });

  it("stops a shell child at its own timeout when it comes before the loop's", async () => {
    fakeTimers(["setTimeout", "clearTimeout"]);
    const { plane, sandbox, execute } = setUpRun();

    const loop = loopStep([{ ...hangStep, timeout: "1m" }], { timeout: "10m" });
    const result = execute(claimedRun([loop]));
    await sandbox.hanging;
    await vi.advanceTimersByTimeAsync(60_000);
    await result;

    expect(plane.finished[0]?.stepResult?.summary).toBe("The step timed out after 1m.");
  });
});
