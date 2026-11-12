import { describe, expect, it, vi } from "vitest";

import {
  createConnectedTestServer,
  secondRepoPath,
  setUpTestDb,
  testQuestions,
  worktreeRunner,
} from "../testing";

const testDb = setUpTestDb();

const setUp = () => createConnectedTestServer(testDb());

describe("GET /api/inbox", () => {
  it("lists only the pending items, oldest first", async () => {
    const { api, plane, waitForApproval } = await setUp();
    const first = await waitForApproval();
    const second = await waitForApproval([first.claimed.lease]);
    await plane.finishRun(second.claimed.lease, "failed");
    const third = await waitForApproval([first.claimed.lease]);

    const items = await api.inbox.list();

    expect(items.map(({ id }) => id)).toEqual([first.itemId, third.itemId]);
  });

  it("gives each item with its run, its repo, its workflow and its step", async () => {
    const { api, plane, runnerId, claimOne, waitForApproval } = await setUp();
    const first = await waitForApproval();
    await api.repos.register({ runnerId, path: secondRepoPath });
    await api.runs.create({ repoId: 2, workflow: "build" });
    const { lease } = await claimOne([first.claimed.lease]);
    const stepRunId = await plane.startStep(lease, "review");
    await plane.startAttempt(lease, stepRunId);
    await plane.openApproval(lease, stepRunId, "Check the web build");

    const items = await api.inbox.list();

    expect(items).toMatchObject([
      { workflowRunId: 1, repoName: "app", workflowName: "Build", stepId: "approve" },
      { workflowRunId: 2, repoName: "web", workflowName: "Build", stepId: "review" },
    ]);
  });

  it("gives a question item its questions and answer, without message, decision and note", async () => {
    const { api, waitForQuestion } = await setUp();
    await waitForQuestion();

    const [item] = await api.inbox.list();

    expect(item).toMatchObject({ kind: "question", questions: testQuestions });
    expect(item).not.toHaveProperty("answer");
    expect(item).not.toHaveProperty("message");
    expect(item).not.toHaveProperty("decision");
    expect(item).not.toHaveProperty("note");
  });

  it("gives a decision item its message, decision and note, without questions and answer", async () => {
    const { api, waitForApproval } = await setUp();
    await waitForApproval();

    const [item] = await api.inbox.list();

    expect(item).toMatchObject({ kind: "approval", message: "Check the diff" });
    expect(item).not.toHaveProperty("decision");
    expect(item).not.toHaveProperty("note");
    expect(item).not.toHaveProperty("questions");
    expect(item).not.toHaveProperty("answer");
  });
});

describe("POST /api/inbox/{id}/resolve", () => {
  it("stores the decision and the note", async () => {
    const { api, waitForApproval } = await setUp();
    const { itemId } = await waitForApproval();

    const item = await api.inbox.resolve({ id: itemId, decision: "approve", note: "Looks good" });

    expect(item).toMatchObject({ decision: "approve", note: "Looks good", resolvedBy: "local" });
  });

  it("sets a waiting run to running", async () => {
    const { api, waitForApproval } = await setUp();
    const { claimed, itemId } = await waitForApproval();

    await api.inbox.resolve({ id: itemId, decision: "approve" });

    expect(await api.runs.get({ id: claimed.lease.workflowRunId })).toMatchObject({
      status: "running",
    });
  });

  it("leaves a queued run queued", async () => {
    const { api, plane, waitForApproval } = await setUp();
    const { claimed, itemId } = await waitForApproval();
    await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });

    await api.inbox.resolve({ id: itemId, decision: "approve" });

    expect(await api.runs.get({ id: claimed.lease.workflowRunId })).toMatchObject({
      status: "queued",
    });
  });

  it("wakes the runner", async () => {
    const { api, commands, waitForApproval } = await setUp();
    const { itemId } = await waitForApproval();
    vi.mocked(commands.wake).mockClear();

    await api.inbox.resolve({ id: itemId, decision: "approve" });

    expect(commands.wake).toHaveBeenCalled();
  });

  it("stores a blank note as no note", async () => {
    const { api, waitForApproval } = await setUp();
    const { itemId } = await waitForApproval();

    expect(
      await api.inbox.resolve({ id: itemId, decision: "reject", note: "  " }),
    ).not.toHaveProperty("note");
  });

  it("answers 409 for an item that is already resolved", async () => {
    const { api, waitForApproval } = await setUp();
    const { itemId } = await waitForApproval();
    await api.inbox.resolve({ id: itemId, decision: "approve" });

    await expect(api.inbox.resolve({ id: itemId, decision: "reject" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("answers 409 for an item of a run that ended", async () => {
    const { api, plane, waitForApproval } = await setUp();
    const { claimed, itemId } = await waitForApproval();
    await plane.finishRun(claimed.lease, "failed");

    await expect(api.inbox.resolve({ id: itemId, decision: "approve" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("stores a gate decision of an ask_human item", async () => {
    const { api, waitForGate } = await setUp();
    const { itemId } = await waitForGate();

    const item = await api.inbox.resolve({ id: itemId, decision: "retry", note: "Mock the clock" });

    expect(item).toMatchObject({ kind: "ask_human", decision: "retry", note: "Mock the clock" });
  });

  it("gives the note of a retry to the step as a message", async () => {
    const { api, plane, waitForGate } = await setUp();
    const { claimed, stepRunId, itemId } = await waitForGate();

    await api.inbox.resolve({ id: itemId, decision: "retry", note: "Mock the clock" });

    const { messages } = await plane.sync({
      held: [claimed.lease],
      capacity: 0,
      capabilities: worktreeRunner,
    });
    expect(messages).toMatchObject([{ stepRunId, text: "Mock the clock", author: "local" }]);
  });

  it("gives the note of a continue to the step as a message", async () => {
    const { api, plane, startAgentStep } = await setUp();
    const { claimed, stepRunId, attemptId } = await startAgentStep();
    const stopped = { status: "stopped" } as const;
    const itemId = await plane.askHuman(claimed.lease, attemptId, {
      result: stopped,
      kind: "limit",
      message: "The agent reached max_turns.",
    });

    await api.inbox.resolve({ id: itemId, decision: "continue", note: "Finish the tests" });

    const { messages } = await plane.sync({
      held: [claimed.lease],
      capacity: 0,
      capabilities: worktreeRunner,
    });
    expect(messages).toMatchObject([{ stepRunId, text: "Finish the tests" }]);
  });

  it("gives the step no message for a retry without a note", async () => {
    const { api, plane, waitForGate } = await setUp();
    const { claimed, itemId } = await waitForGate();

    await api.inbox.resolve({ id: itemId, decision: "retry" });

    const { messages } = await plane.sync({
      held: [claimed.lease],
      capacity: 0,
      capabilities: worktreeRunner,
    });
    expect(messages).toEqual([]);
  });

  it("answers 400 for a decision that the kind of the item does not take", async () => {
    const { api, waitForApproval } = await setUp();
    const { itemId } = await waitForApproval();

    await expect(api.inbox.resolve({ id: itemId, decision: "retry" })).rejects.toMatchObject({
      status: 400,
      message: `Inbox item ${itemId} takes one of these decisions: approve, reject`,
    });
  });

  it("stores the answer of a question item", async () => {
    const { api, waitForQuestion } = await setUp();
    const { itemId } = await waitForQuestion();
    const answer = [{ selected: ["SQLite"], other: "In memory" }];

    const item = await api.inbox.resolve({ id: itemId, answer });

    expect(item).toMatchObject({ answer });
  });

  it("answers 409 for a question of a step that has an undelivered message", async () => {
    const { api, plane, startAgentStep } = await setUp();
    const { claimed, stepRunId, attemptId } = await startAgentStep();
    const itemId = await plane.askQuestion(claimed.lease, attemptId, testQuestions);
    await api.runs.sendMessage({ id: 1, stepRunId, text: "Use SQLite" });
    const answer = [{ selected: ["SQLite"], other: null }];

    await expect(api.inbox.resolve({ id: itemId, answer })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("stores blank other text as no other text", async () => {
    const { api, waitForQuestion } = await setUp();
    const { itemId } = await waitForQuestion();
    const answer = [{ selected: ["SQLite"], other: "  " }];

    const item = await api.inbox.resolve({ id: itemId, answer });

    expect(item).toMatchObject({ answer: [{ selected: ["SQLite"], other: null }] });
  });

  it("answers 400 with the problem of an answer that does not fit the questions", async () => {
    const { api, waitForQuestion } = await setUp();
    const { itemId } = await waitForQuestion();
    const answer = [{ selected: ["MySQL"], other: null }];

    await expect(api.inbox.resolve({ id: itemId, answer })).rejects.toMatchObject({
      status: 400,
      message: 'Question 1 has no option "MySQL"',
    });
  });

  it("answers 400 for a question item with a decision", async () => {
    const { api, waitForQuestion } = await setUp();
    const { itemId } = await waitForQuestion();

    await expect(api.inbox.resolve({ id: itemId, decision: "approve" })).rejects.toMatchObject({
      status: 400,
      message: `Inbox item ${itemId} takes an answer, not a decision`,
    });
  });

  it("answers 400 for an input with a note and an answer", async () => {
    const { api, waitForQuestion } = await setUp();
    const { itemId } = await waitForQuestion();
    const input = { id: itemId, note: "Thanks", answer: [{ selected: ["SQLite"], other: null }] };

    await expect(api.inbox.resolve(input)).rejects.toMatchObject({
      status: 400,
      code: "BAD_REQUEST",
    });
  });

  it("answers 400 for an approval item with an answer", async () => {
    const { api, waitForApproval } = await setUp();
    const { itemId } = await waitForApproval();
    const answer = [{ selected: ["SQLite"], other: null }];

    await expect(api.inbox.resolve({ id: itemId, answer })).rejects.toMatchObject({
      status: 400,
      message: `Inbox item ${itemId} takes a decision, not an answer`,
    });
  });

  it("answers 404 for an unknown item", async () => {
    const { api } = await setUp();

    await expect(api.inbox.resolve({ id: 1, decision: "approve" })).rejects.toMatchObject({
      status: 404,
    });
  });
});
