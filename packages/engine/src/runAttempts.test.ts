import { invalidInput, leaseLost, type RecordedStep } from "@halinka/protocol";
import { describe, expect, it } from "vitest";

import { agentStep, approvalStep, claimedRun, readOnly, setUpRun } from "./testing";

describe("runAttempts", () => {
  it("publishes the checkpoint before it stores the attempt", async () => {
    const storedAfter: string[][] = [];
    const { repoSource, execute } = setUpRun({
      finishAttempt: async () => {
        storedAfter.push([...repoSource.published]);
        return {};
      },
    });

    await execute(claimedRun(["generate"]));

    expect(storedAfter).toEqual([["sha-1"]]);
  });

  it("publishes nothing for an attempt that changed no files", async () => {
    const { repoSource, execute } = setUpRun();

    await execute(claimedRun(["build"]));

    expect(repoSource.published).toEqual([]);
  });

  it("fails the attempt when the repo refuses the checkpoint", async () => {
    const { plane, repoSource, execute } = setUpRun();
    repoSource.refusePublish("the branch moved away from the run");

    expect(await execute(claimedRun([agentStep({ prompt: "fix the bug" })]))).toBe("failed");

    expect(plane.lastEvent()).toMatchObject({
      payload: { status: "failed", error: "the branch moved away from the run" },
    });
  });

  it("commits the changes before a shell step first", async () => {
    const { plane, sandbox, execute } = setUpRun();
    sandbox.setChangesBefore(["dist/app.js"]);

    await execute(claimedRun(["generate"]));

    expect(plane.finished[0]?.result.checkpoint).toMatchObject({ before: "sha-1", after: "sha-2" });
  });

  it("keeps the changes of an interrupted shell attempt in the next attempt", async () => {
    const { plane, sandbox, execute } = setUpRun({
      startAttempt: async () => ({ attemptId: 11, attempt: 2 }),
    });
    sandbox.setChangesBefore(["src/half.ts"]);
    const recorded: RecordedStep[] = [
      { stepRunId: 1, stepId: "s1", status: "running", failedAttempts: 0 },
    ];

    await execute(claimedRun(["test"], recorded));

    expect(plane.finished[0]?.result.checkpoint).toMatchObject({ before: "sha-0", after: "sha-1" });
  });

  it("commits the changes before an interrupted shell attempt when a person opened the workspace", async () => {
    const { plane, sandbox, execute } = setUpRun({
      startAttempt: async () => ({ attemptId: 11, attempt: 2 }),
    });
    sandbox.setChangesBefore(["src/edit.ts"]);
    const recorded: RecordedStep[] = [
      { stepRunId: 1, stepId: "s1", status: "running", failedAttempts: 0 },
    ];

    await execute({ ...claimedRun(["test"], recorded), isWorkspaceOpened: true });

    expect(plane.finished[0]?.result.checkpoint).toMatchObject({ before: "sha-1" });
  });

  it("stops the running step when the server refuses a batch with lease_lost", async () => {
    const { plane, execute } = setUpRun({
      appendEvents: async () => {
        throw leaseLost(1);
      },
    });

    await expect(execute(claimedRun(["hang"]))).rejects.toMatchObject({ code: "lease_lost" });

    expect(plane.calls).toEqual(["startStep s1", "startAttempt 10"]);
  });

  it("stops a step that waits for a decision when the server refuses a batch for good", async () => {
    const { plane, execute } = setUpRun({
      appendEvents: async () => {
        throw invalidInput("The batch is not valid");
      },
    });

    await expect(execute(claimedRun([approvalStep]))).rejects.toThrow(
      "The server refused the events of the run: The batch is not valid",
    );

    expect(plane.calls).toEqual([
      "startStep approve",
      "startAttempt 10",
      "openApproval 10 Check the diff",
    ]);
  });

  const abortedInAgentStep = async () => {
    const { plane, agent, controller, execute } = setUpRun();
    const result = execute(claimedRun([agentStep({ prompt: "hang" })]));
    await agent.running;
    controller.abort();
    expect(await result).toBe("aborted");
    return plane;
  };

  it("on abort, leaves the agent step run open", async () => {
    const plane = await abortedInAgentStep();

    expect(plane.calls).toEqual(["startStep a1", "startAttempt 10"]);
  });

  it("on abort, drops the report the agent returns", async () => {
    const plane = await abortedInAgentStep();

    expect(plane.eventKinds()).toEqual([
      "attempt_started",
      "agent_prompt",
      "agent_session",
      "agent_update",
      "agent_update",
    ]);
  });

  it("stops the running agent step when the server refuses a batch with lease_lost", async () => {
    const { plane, execute } = setUpRun({
      appendEvents: async () => {
        throw leaseLost(1);
      },
    });

    await expect(execute(claimedRun([agentStep({ prompt: "hang" })]))).rejects.toMatchObject({
      code: "lease_lost",
    });

    expect(plane.calls).toEqual(["startStep a1", "startAttempt 10"]);
  });

  it("gives a failed step its error as its summary", async () => {
    const { plane, execute } = setUpRun();

    await execute(claimedRun([agentStep({ prompt: "fix the bug", agent: "missing" })]));

    expect(plane.finished[0]?.stepResult?.summary).toBe('The agent "missing" is not available');
  });

  it("commits the changes before an attempt as their own commit", async () => {
    const { plane, sandbox, execute } = setUpRun();
    sandbox.setChangesBefore(["dist/app.js"]);

    await execute(claimedRun([agentStep({ prompt: "fix the bug" })]));

    expect(plane.finished[0]?.result.checkpoint).toMatchObject({ before: "sha-1", after: "sha-2" });
  });

  it("fails non-empty-diff when only the changes before the attempt changed files", async () => {
    const { sandbox, execute } = setUpRun();
    sandbox.setChangesBefore(["dist/app.js"]);
    sandbox.setAgentChanges([]);

    const step = {
      ...agentStep({ prompt: "fix the bug" }),
      max_attempts: 1,
      on_exhausted: "fail" as const,
    };
    expect(await execute(claimedRun([step]))).toBe("failed");
  });

  it("does not blame a read-only agent for the changes before the attempt", async () => {
    const { sandbox, execute } = setUpRun();
    sandbox.setChangesBefore(["dist/app.js"]);
    sandbox.setAgentChanges([]);

    const step = readOnly();
    expect(await execute(claimedRun([step]))).toBe("succeeded");
  });

  it("publishes the commit of the changes before a read-only attempt before it stores the attempt", async () => {
    const storedAfter: string[][] = [];
    const { sandbox, repoSource, execute } = setUpRun({
      finishAttempt: async () => {
        storedAfter.push([...repoSource.published]);
        return {};
      },
    });
    sandbox.setChangesBefore(["dist/app.js"]);
    sandbox.setAgentChanges([]);

    await execute(claimedRun([readOnly()]));

    expect(storedAfter).toEqual([["sha-1"]]);
  });

  it("commits the changes before a retry after a resume", async () => {
    const { plane, sandbox, inbox, execute } = setUpRun({
      startAttempt: async () => ({ attemptId: 11, attempt: 2 }),
    });
    inbox.decide(5, "retry");
    sandbox.setChangesBefore(["dist/app.js"]);

    const recorded: RecordedStep[] = [
      {
        stepRunId: 1,
        stepId: "a1",
        status: "running",
        failedAttempts: 1,
        attemptItem: { itemId: 5, kind: "ask_human", summary: "Done" },
      },
    ];
    await execute(claimedRun([agentStep({ prompt: "fix the bug" })], recorded));

    expect(plane.finished[0]?.result.checkpoint).toMatchObject({ before: "sha-1" });
  });

  const interrupted: RecordedStep[] = [
    { stepRunId: 1, stepId: "a1", status: "running", failedAttempts: 0 },
  ];

  it("keeps the changes before an attempt that follows an interrupted attempt", async () => {
    const { plane, sandbox, execute } = setUpRun({
      startAttempt: async () => ({ attemptId: 11, attempt: 2 }),
    });
    sandbox.setChangesBefore(["src/half.ts"]);

    await execute(claimedRun([agentStep({ prompt: "fix the bug" })], interrupted));

    expect(plane.finished[0]?.result.checkpoint).toMatchObject({ before: "sha-0", after: "sha-1" });
  });

  it("discards the changes before a read-only attempt that follows an interrupted attempt", async () => {
    const { plane, sandbox, execute } = setUpRun({
      startAttempt: async () => ({ attemptId: 11, attempt: 2 }),
    });
    sandbox.setChangesBefore(["notes.md"]);
    sandbox.setAgentChanges([]);

    const step = readOnly();
    expect(await execute(claimedRun([step], interrupted))).toBe("succeeded");

    expect(plane.finished[0]?.result.checkpoint).toEqual({
      before: "sha-0",
      after: "sha-0",
      changedFiles: [],
    });
  });

  it("stores the agent time and the cost of an agent attempt", async () => {
    const { plane, execute } = setUpRun();

    await execute(claimedRun([agentStep({ prompt: "report cost 3" })]));

    expect(plane.finished[0]?.result.usage).toEqual({ activeMs: expect.any(Number), costUsd: 3 });
  });

  it("stores only its own cost for a later attempt of the same session", async () => {
    const { plane, execute } = setUpRun();

    const step = {
      ...agentStep({ prompt: "report cost 3" }),
      gates: [{ name: "tests", run: "fail once" }],
    };
    await execute(claimedRun([step]));

    expect(plane.finished[1]?.result.usage?.costUsd).toBe(3);
  });

  it("stores the command time of a shell attempt", async () => {
    const { plane, execute } = setUpRun();

    await execute(claimedRun(["build"]));

    expect(plane.finished[0]?.result.usage).toEqual({ activeMs: expect.any(Number) });
  });
});
