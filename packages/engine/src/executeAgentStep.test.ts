import type { LeafStep } from "@halinka/workflow";
import { describe, expect, it } from "vitest";

import { agentStep, claimedRun, readOnly, reportPrompt, setUpRun } from "./testing";

describe("executeAgentStep", () => {
  it("runs the git calls of a checkpoint without network", async () => {
    const { sandbox, execute } = setUpRun();

    await execute(claimedRun([agentStep({ prompt: "fix the bug" })]));

    expect(new Set(sandbox.gitNetworks)).toEqual(new Set([undefined]));
  });

  it("succeeds the agent step with the summary when the agent reports a result", async () => {
    const { plane, execute } = setUpRun();

    expect(await execute(claimedRun([agentStep({ prompt: "fix the bug" })]))).toBe("succeeded");

    expect(plane.calls).toContain("finishAttempt 11 succeeded undefined succeeded");
    expect(plane.lastEvent()).toMatchObject({
      kind: "attempt_finished",
      payload: { status: "succeeded", summary: "Done: fix the bug" },
    });
  });

  it("opens the session as read-only", async () => {
    const { sandbox, agent, execute } = setUpRun();
    sandbox.setAgentChanges([]);

    await execute(claimedRun([readOnly()]));

    expect(agent.permissions()).toMatchObject({ write: false });
  });

  it("stores the head before as the checkpoint of a read-only attempt", async () => {
    const { plane, sandbox, execute } = setUpRun();
    sandbox.setAgentChanges([]);

    expect(await execute(claimedRun([readOnly()]))).toBe("succeeded");

    expect(plane.finished[0]?.result.checkpoint).toEqual({
      before: "sha-0",
      after: "sha-0",
      changedFiles: [],
    });
  });

  it("sends no checkpoint event for a read-only step", async () => {
    const { plane, sandbox, execute } = setUpRun();
    sandbox.setAgentChanges([]);

    await execute(claimedRun([readOnly()]));

    expect(plane.eventKinds()).not.toContain("checkpoint");
  });

  it("fails a read-only step with the files that the agent changed", async () => {
    const { plane, sandbox, execute } = setUpRun();
    sandbox.setAgentChanges(["a.ts", "b.ts"]);

    expect(await execute(claimedRun([readOnly()]))).toBe("failed");

    expect(plane.finished[0]?.stepResult?.summary).toBe(
      "Done: review the code\n\n" +
        "The step is read-only, but the agent changed these files: a.ts, b.ts. " +
        "Halinka discarded the changes.",
    );
  });

  it("does not retry or run the gates of a read-only step that changed files", async () => {
    const { plane, sandbox, execute } = setUpRun();

    await execute(claimedRun([readOnly({ gates: [{ name: "tests", run: "test" }] })]));

    expect(plane.calls.filter((call) => call.startsWith("startAttempt"))).toHaveLength(1);
    expect(sandbox.ran).toEqual([]);
  });

  it("adds the changed files to the error of a failed read-only attempt", async () => {
    const { plane, execute } = setUpRun();

    await execute(claimedRun([readOnly({ prompt: "refuse" })]));

    expect(plane.finished[0]?.stepResult?.summary).toBe(
      "The agent stopped the turn: refusal\n\n" +
        "The step is read-only, but the agent changed these files: src/app.ts. " +
        "Halinka discarded the changes.",
    );
  });

  it("runs the declared gates when the agent changes no files", async () => {
    const { sandbox, execute } = setUpRun();
    sandbox.setAgentChanges([]);

    await execute(claimedRun([readOnly({ gates: [{ name: "tests", run: "test" }] })]));

    expect(sandbox.ran).toEqual(["test"]);
  });

  it("stores a checkpoint event with the heads before and after the attempt", async () => {
    const { plane, execute } = setUpRun();

    await execute(claimedRun([agentStep({ prompt: "fix the bug" })]));

    expect(plane.events().find(({ kind }) => kind === "checkpoint")?.payload).toEqual({
      stepId: "a1",
      attemptId: 11,
      before: "sha-0",
      after: "sha-1",
    });
  });

  it("commits a checkpoint when the agent does not report a result", async () => {
    const { plane, execute } = setUpRun();

    await execute(claimedRun([agentStep({ prompt: "silent" })]));

    expect(plane.eventKinds()).toContain("checkpoint");
  });

  it("fails the agent attempt when the checkpoint fails", async () => {
    const { plane, sandbox, execute } = setUpRun();
    sandbox.failGit("add");

    expect(await execute(claimedRun([agentStep({ prompt: "fix the bug" })]))).toBe("failed");

    expect(plane.lastEvent()).toMatchObject({
      payload: { status: "failed", error: "git add failed with exit code 128: fatal: add failed" },
    });
  });

  it("makes no checkpoint when the agent throws", async () => {
    const { plane, execute } = setUpRun();

    await execute(claimedRun([agentStep({ prompt: "crash" })]));

    expect(plane.eventKinds()).not.toContain("checkpoint");
  });

  it("sends no checkpoint with the attempt when the agent throws", async () => {
    const { plane, execute } = setUpRun();

    await execute(claimedRun([agentStep({ prompt: "crash" })]));

    expect(plane.finished[0]?.result.checkpoint).toBeUndefined();
  });

  it("gives an agent step the summary of its report", async () => {
    const { plane, execute } = setUpRun();

    await execute(claimedRun([agentStep({ prompt: "fix the bug" })]));

    expect(plane.finished[0]?.stepResult).toEqual({
      status: "succeeded",
      summary: "Done: fix the bug",
      outcome: undefined,
    });
  });

  it("gives the agent the report shape of the step", async () => {
    const { agent, execute } = setUpRun();
    const outputs = { files: { type: "array" as const, items: "string" as const } };

    await execute(
      claimedRun([agentStep({ prompt: "fix the bug", outcomes: ["approve"], outputs })]),
    );

    expect(agent.reportShape()).toEqual({ outcomes: ["approve"], outputs });
  });

  it("stores the outcome and outputs of the report", async () => {
    const { plane, execute } = setUpRun();
    const report = { summary: "Looks good", outcome: "approve", outputs: { findings: 0 } };
    const step: LeafStep = {
      ...agentStep({ prompt: `${reportPrompt}${JSON.stringify(report)}` }),
      outcomes: ["approve", "reject"],
      outputs: { findings: "number" },
    };

    await execute(claimedRun([step]));

    expect(plane.finished[0]?.stepResult).toEqual({ status: "succeeded", ...report });
  });

  it("fails the agent step when its outcome maps to fail", async () => {
    const { plane, execute } = setUpRun();
    const report = { summary: "The build tool is missing", outcome: "blocked" };
    const step = {
      ...agentStep({ prompt: `${reportPrompt}${JSON.stringify(report)}` }),
      outcomes: { done: "ok", blocked: "fail" } as const,
    };

    expect(await execute(claimedRun([step]))).toBe("failed");

    expect(plane.finished[0]?.stepResult).toEqual({ status: "failed", ...report });
  });

  it("sends the checkpoint of an agent attempt with its result", async () => {
    const { plane, execute } = setUpRun();

    await execute(claimedRun([agentStep({ prompt: "fix the bug" })]));

    expect(plane.finished[0]?.result.checkpoint).toEqual({
      before: "sha-0",
      after: "sha-1",
      changedFiles: ["src/app.ts"],
    });
  });

  it("starts the checkpoint of the second agent step from the checkpoint of the first", async () => {
    const { plane, execute } = setUpRun();

    await execute(
      claimedRun([agentStep({ prompt: "fix the bug" }), agentStep({ prompt: "again", id: "a2" })]),
    );

    const befores = plane
      .events()
      .flatMap(({ kind, payload }) => (kind === "checkpoint" ? [payload.before] : []));
    expect(befores).toEqual(["sha-0", "sha-1"]);
  });
});
