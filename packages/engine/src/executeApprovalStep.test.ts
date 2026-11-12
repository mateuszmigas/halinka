import type { RecordedStep } from "@halinka/protocol";
import type { LeafStep } from "@halinka/workflow";
import { describe, expect, it } from "vitest";

import { approvalStep, claimedRun, readOnly, setUpRun } from "./testing";

describe("executeApprovalStep", () => {
  it("succeeds the approval step when a person approves", async () => {
    const { plane, inbox, execute } = setUpRun();
    inbox.decide(7, "approve");

    expect(await execute(claimedRun([approvalStep]))).toBe("succeeded");

    expect(plane.calls).toEqual([
      "startStep approve",
      "startAttempt 10",
      "openApproval 10 Check the diff",
      "finishAttempt 11 succeeded undefined succeeded",
    ]);
    expect(plane.lastEvent()).toMatchObject({
      payload: { status: "succeeded", summary: "Approved" },
    });
  });

  it("adds the note of the person to the summary", async () => {
    const { plane, inbox, execute } = setUpRun();
    inbox.decide(7, "reject", "Add a test");

    await execute(claimedRun([approvalStep]));

    expect(plane.lastEvent()).toMatchObject({ payload: { summary: "Rejected: Add a test" } });
  });

  it("fails the approval step and the run when a person rejects", async () => {
    const { plane, sandbox, inbox, execute } = setUpRun();
    inbox.decide(7, "reject");

    expect(await execute(claimedRun([approvalStep, "deploy"]))).toBe("failed");

    expect(plane.calls).toContain("finishAttempt 11 failed undefined failed");
    expect(sandbox.ran).toEqual([]);
  });

  it("fails the approval step when the decision is not an approval decision", async () => {
    const { plane, inbox, execute } = setUpRun();
    inbox.decide(7, "accept");

    expect(await execute(claimedRun([approvalStep]))).toBe("failed");

    expect(plane.finished[0]?.stepResult).toMatchObject({
      summary: 'Inbox item 7 got the decision "accept"',
    });
  });

  it("on abort while it waits for a decision, leaves the approval step run open", async () => {
    const { plane, inbox, controller, execute } = setUpRun();

    const result = execute(claimedRun([approvalStep]));
    await inbox.waiting;
    controller.abort();

    expect(await result).toBe("aborted");
    expect(plane.calls).toEqual([
      "startStep approve",
      "startAttempt 10",
      "openApproval 10 Check the diff",
    ]);
  });

  it.each([
    ["approve", "approved"],
    ["reject", "rejected"],
  ] as const)("gives an approval step the outcome of %s", async (decision, outcome) => {
    const { plane, inbox, execute } = setUpRun();
    inbox.decide(7, decision);

    await execute(claimedRun([approvalStep]));

    expect(plane.finished[0]?.stepResult?.outcome).toBe(outcome);
  });

  const approval: LeafStep = { ...approvalStep, reviewers: ["a1"] } as LeafStep;

  const reviewed = (fields: Partial<RecordedStep>): RecordedStep[] => [
    { stepRunId: 1, stepId: "a1", status: "succeeded", failedAttempts: 0, ...fields },
  ];

  it("opens the approval when the reviewer reviewed the branch head", async () => {
    const { plane, inbox, execute } = setUpRun();
    inbox.decide(7, "approve");
    const recorded = reviewed({ commit: "sha-0" });

    expect(await execute(claimedRun([readOnly(), approval], recorded))).toBe("succeeded");

    expect(plane.calls).toContain("openApproval 10 Check the diff");
  });

  it("opens no approval when the branch changed after the review", async () => {
    const { plane, execute } = setUpRun();
    const recorded = reviewed({ commit: "abc1234def" });

    await execute(claimedRun([readOnly(), approval], recorded));

    expect(plane.calls.some((call) => call.startsWith("openApproval"))).toBe(false);
  });

  it("fails the approval when the branch changed after the review", async () => {
    const { plane, execute } = setUpRun();
    const recorded = reviewed({ commit: "abc1234def" });

    expect(await execute(claimedRun([readOnly(), approval], recorded))).toBe("failed");

    expect(plane.finished.at(-1)?.stepResult).toEqual({
      status: "failed",
      summary: "The step `a1` reviewed abc1234, but the branch is at sha-0.",
    });
  });

  it("fails the approval when the reviewer was skipped", async () => {
    const { plane, execute } = setUpRun();
    const recorded = reviewed({ status: "skipped" });

    expect(await execute(claimedRun([readOnly(), approval], recorded))).toBe("failed");

    expect(plane.finished.at(-1)?.stepResult?.summary).toBe(
      "The step `a1` did not review the branch.",
    );
  });
});
