import { pullRequestText } from "@halinka/protocol";
import { fakeTimers } from "@halinka/utils/testing";
import type { LeafStep } from "@halinka/workflow";
import { describe, expect, it, vi } from "vitest";

import { agentStep, claimedRun, loopStep, reportPrompt, setUpRun } from "./testing";

describe("executeGitHubStep", () => {
  const commentStep = {
    id: "report",
    type: "github",
    action: "comment_on_pull_request",
    body: "Done",
  } as const;

  it("gives the body and the ids to the repo source", async () => {
    const { repoSource, execute } = setUpRun();

    await execute(claimedRun([commentStep]));

    expect(repoSource.commentOnPullRequest.mock.calls[0]?.[0]).toEqual({
      stepRunId: 10,
      stepId: "report",
      body: "Done",
    });
  });

  it("gives the comment as an output", async () => {
    const { plane, execute } = setUpRun();

    await execute(claimedRun([commentStep]));

    expect(plane.finished[0]?.result).toMatchObject({
      status: "succeeded",
      outputs: { comment_url: "https://github.com/acme/app/pull/7#issuecomment-1" },
    });
  });

  it("fails the step when GitHub refuses", async () => {
    const { plane, repoSource, execute } = setUpRun();
    repoSource.commentOnPullRequest.mockResolvedValue({ error: "GitHub answered 403" });

    await execute(claimedRun([commentStep]));

    expect(plane.finished[0]?.result).toMatchObject({
      status: "failed",
      summary: "GitHub answered 403",
    });
  });

  const gitHubStep = {
    id: "publish",
    type: "github",
    action: "open_pull_request",
  } as const;

  it("asks the port with the step run and the fixed text", async () => {
    const { repoSource, execute } = setUpRun();

    await execute(claimedRun([gitHubStep]));

    expect(repoSource.openPullRequest.mock.calls[0]?.[0]).toEqual({
      stepRunId: 10,
      title: "Test (Halinka run #1)",
      body: "Opened from Halinka run #1.",
    });
  });

  const withIssue = (step: LeafStep) => ({
    ...claimedRun([step]),
    inputs: { issue_number: 133, issue_title: "Add shapes" },
  });

  it("asks the port with the text of the step", async () => {
    const { repoSource, execute } = setUpRun();
    const step = {
      ...gitHubStep,
      title: "${{ inputs.issue_title }}",
      body: "Done",
      closes: "${{ inputs.issue_number }}",
    };

    await execute(withIssue(step));

    expect(repoSource.openPullRequest.mock.calls[0]?.[0]).toEqual({
      stepRunId: 10,
      ...pullRequestText(1, "Test", { title: "Add shapes", body: "Done", closes: 133 }),
    });
  });

  const withNoIssueNumber = withIssue({ ...gitHubStep, closes: "${{ inputs.issue_title }}" });

  it("fails the step when closes gives no issue number", async () => {
    const { plane, execute } = setUpRun();

    await execute(withNoIssueNumber);

    expect(plane.finished[0]?.result).toMatchObject({
      status: "failed",
      summary: 'closes gives "Add shapes", which is not an issue number',
    });
  });

  it("opens no pull request when closes gives no issue number", async () => {
    const { repoSource, execute } = setUpRun();

    await execute(withNoIssueNumber);

    expect(repoSource.openPullRequest).not.toHaveBeenCalled();
  });

  it("gives the URL as an output", async () => {
    const { plane, execute } = setUpRun();

    expect(await execute(claimedRun([gitHubStep]))).toBe("succeeded");

    expect(plane.finished[0]?.stepResult?.outputs).toEqual({
      pull_request_url: "https://github.com/acme/app/pull/1",
    });
  });

  it("says that the pull request opened", async () => {
    const { plane, execute } = setUpRun();

    await execute(claimedRun([gitHubStep]));

    expect(plane.finished[0]?.stepResult?.summary).toBe(
      "The pull request is open: https://github.com/acme/app/pull/1",
    );
  });

  it("says that the pull request is already open", async () => {
    const { plane, repoSource, execute } = setUpRun();
    repoSource.openPullRequest.mockResolvedValue({
      url: "https://github.com/acme/app/pull/1",
      isCreated: false,
    });

    await execute(claimedRun([gitHubStep]));

    expect(plane.finished[0]?.stepResult?.summary).toBe(
      "The pull request is already open: https://github.com/acme/app/pull/1",
    );
  });

  it("fails the step with the error of GitHub", async () => {
    const { plane, repoSource, execute } = setUpRun();
    repoSource.openPullRequest.mockResolvedValue({ error: "GitHub answered 422" });

    expect(await execute(claimedRun([gitHubStep]))).toBe("failed");

    expect(plane.finished[0]?.stepResult?.summary).toBe("GitHub answered 422");
  });

  it("fails the step with a refusal of the port", async () => {
    const { plane, repoSource, execute } = setUpRun();
    repoSource.openPullRequest.mockRejectedValue(new Error("The review is old"));

    expect(await execute(claimedRun([gitHubStep]))).toBe("failed");

    expect(plane.finished[0]?.stepResult?.summary).toBe("The review is old");
  });

  it.each([
    ["its timeout", { ...gitHubStep, timeout: "1m" }, 60_000, "The step timed out after 1m."],
    ["the default timeout", gitHubStep, 600_000, "The step timed out after 10m."],
  ])("fails the step at %s", async (_name, step, ms, summary) => {
    fakeTimers(["setTimeout", "clearTimeout"]);
    const { plane, repoSource, execute } = setUpRun();
    const hanging = Promise.withResolvers<void>();
    repoSource.openPullRequest.mockImplementation(
      (_request, signal) =>
        new Promise((_, reject) => {
          hanging.resolve();
          signal.addEventListener("abort", () => reject(new Error("stopped")));
        }),
    );

    const result = execute(claimedRun([step]));
    await hanging.promise;
    await vi.advanceTimersByTimeAsync(ms);

    expect(await result).toBe("failed");
    expect(plane.finished[0]?.stepResult?.summary).toBe(summary);
  });

  const review = (outcome: string): LeafStep => ({
    ...agentStep({ prompt: `${reportPrompt}{"summary":"Done","outcome":"${outcome}"}` }),
    id: "review",
    permissions: { write: false },
    outcomes: ["approve", "changes_requested"],
  });

  const issueToPr = (outcome: string) =>
    claimedRun([
      loopStep(
        [
          agentStep({ prompt: "fix the issue", id: "implement", require_changes: false }),
          review(outcome),
        ],
        {
          max_iterations: 2,
          until: "${{ steps.review.outcome == 'approve' }}",
        },
      ),
      { id: "approve", type: "approval", message: "Ship it", reviewers: ["review"] },
      gitHubStep,
    ]);

  it("opens the pull request when the person approves", async () => {
    const { sandbox, inbox, repoSource, execute } = setUpRun();
    sandbox.setAgentChanges([]);
    inbox.decide(7, "approve");

    expect(await execute(issueToPr("approve"))).toBe("succeeded");

    expect(repoSource.openPullRequest).toHaveBeenCalledOnce();
  });

  it("opens no pull request when the person rejects", async () => {
    const { sandbox, inbox, repoSource, execute } = setUpRun();
    sandbox.setAgentChanges([]);
    inbox.decide(7, "reject");

    expect(await execute(issueToPr("approve"))).toBe("failed");

    expect(repoSource.openPullRequest).not.toHaveBeenCalled();
  });

  it("opens no pull request when the review never approves", async () => {
    const { plane, sandbox, repoSource, execute } = setUpRun();
    sandbox.setAgentChanges([]);

    expect(await execute(issueToPr("changes_requested"))).toBe("failed");

    expect(plane.calls.filter((call) => call.startsWith("startStep review"))).toHaveLength(2);
    expect(plane.calls.some((call) => call.startsWith("openApproval"))).toBe(false);
    expect(repoSource.openPullRequest).not.toHaveBeenCalled();
  });

  it("records the time of the step for the budget of its loop", async () => {
    const { plane, execute } = setUpRun();

    await execute(claimedRun([gitHubStep]));

    expect(plane.finished[0]?.result.usage).toEqual({ activeMs: expect.any(Number) });
  });

  it("gets at most the rest of the time of its loop", async () => {
    fakeTimers(["setTimeout", "clearTimeout"]);
    const { plane, repoSource, execute } = setUpRun();
    const hanging = Promise.withResolvers<void>();
    repoSource.openPullRequest.mockImplementation(
      (_request, signal) =>
        new Promise((_, reject) => {
          hanging.resolve();
          signal.addEventListener("abort", () => reject(new Error("stopped")));
        }),
    );
    const loop = loopStep([gitHubStep], { timeout: "1m" });

    const result = execute(claimedRun([loop]));
    await hanging.promise;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await result).toBe("failed");
    expect(plane.finished[0]?.stepResult?.summary).toContain("The step reached");
  });

  it("leaves the step run open when the run stops", async () => {
    const { plane, repoSource, controller, execute } = setUpRun();
    repoSource.openPullRequest.mockImplementation(async () => {
      controller.abort();
      throw new Error("stopped");
    });

    expect(await execute(claimedRun([gitHubStep]))).toBe("aborted");

    expect(plane.finished).toEqual([]);
  });
});
