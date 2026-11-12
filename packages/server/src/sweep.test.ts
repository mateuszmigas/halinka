import type { Checkpoint, RunLease, SandboxKind } from "@halinka/protocol";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { createRepositories } from "./db/repositories";
import { WorkflowRunRepository } from "./db/repositories/workflowRunRepository";
import {
  agentTests,
  gitHubDeliveries,
  inboxItems,
  runCalls,
  runnerEnrollments,
  runners,
  stepAttempts,
  workflowRuns,
} from "./db/schema";
import { defaultLeaseTimes } from "./leaseTimes";
import { RunBus } from "./runBus";
import { sweep } from "./sweep";
import {
  createConnectedTestServer,
  devcontainerRunner,
  requestedAgentTest,
  runningAgentTest,
  setUpTestDb,
  syncRunner,
  testQuestions,
  worktreeRunner,
} from "./testing";

const testDb = setUpTestDb();

const sweepAll = (bus = new RunBus()) => sweep(testDb(), bus, defaultLeaseTimes.leaseSeconds);

const shipWorkflow = [
  "schema_version: 1",
  "name: Ship",
  "steps:",
  "  - id: implement",
  "    type: agent",
  "    agent: claude-code",
  "    prompt: Fix",
  "  - id: review",
  "    type: agent",
  "    agent: claude-code",
  "    prompt: Review",
].join("\n");

const openedHoursAgo = (hours: number) =>
  testDb()
    .update(inboxItems)
    .set({ createdAt: sql`now() - make_interval(hours => ${hours})` });

const waitingApproval = async (sandboxKind?: SandboxKind) => {
  const server = await createConnectedTestServer(testDb());
  const waiting = await server.waitForApproval([], sandboxKind);
  const readStatus = async () => (await server.api.runs.get({ id: 1 })).status;
  return { ...server, ...waiting, readStatus };
};

const expiredApproval = async (sandboxKind?: SandboxKind) => {
  const server = await waitingApproval(sandboxKind);
  await openedHoursAgo(25);
  await sweepAll();
  return server;
};

const waitingReviewQuestion = async () => {
  const server = await createConnectedTestServer(testDb());
  const { files, api, plane, claimOne } = server;
  files[".halinka/workflows/ship.yml"] = shipWorkflow;
  await api.runs.create({ repoId: 1, workflow: "ship" });
  const { lease } = await claimOne();
  const implement = await plane.startStep(lease, "implement");
  const implemented = await plane.startAttempt(lease, implement);
  const fixed = { status: "succeeded", summary: "Fixed" } as const;
  await plane.finishAttempt(lease, implemented.attemptId, { result: fixed, stepResult: fixed });
  const review = await plane.startStep(lease, "review");
  const { attemptId } = await plane.startAttempt(lease, review);
  await plane.askQuestion(lease, attemptId, testQuestions);
  const readStatus = async () => (await api.runs.get({ id: 1 })).status;
  return { ...server, implement, review, readStatus };
};

const expiredReviewQuestion = async () => {
  const server = await waitingReviewQuestion();
  await openedHoursAgo(25);
  await sweepAll();
  return server;
};

const finishedHoursAgo = (hours: number) =>
  testDb()
    .update(workflowRuns)
    .set({
      finishedAt: sql`now() - make_interval(hours => ${hours})`,
      sandboxKeptAt: sql`now() - make_interval(hours => ${hours})`,
    })
    .where(eq(workflowRuns.id, 1));

const specOfRun = async () =>
  (await testDb().select().from(workflowRuns).where(eq(workflowRuns.id, 1)))[0]?.sandbox;

const finishedRunIn = async (sandboxKind: SandboxKind, hours: number) => {
  const server = await createConnectedTestServer(testDb());
  await server.finishOne(sandboxKind);
  await finishedHoursAgo(hours);
  return server;
};

const finishedRun = (hours: number) => finishedRunIn("worktree", hours);

const addRunCall = () =>
  createRepositories(testDb()).runCall.start({
    workflowRunId: 1,
    callId: "call-1",
    leaseToken: "lease",
    callHash: "hash",
  });

const runCallCount = async () => (await testDb().select().from(runCalls)).length;

const callsOfRunFinishedHoursAgo = async (hours: number) => {
  const { finishOne } = await createConnectedTestServer(testDb());
  await finishOne();
  await addRunCall();
  await finishedHoursAgo(hours);
};

const addToken = (tokenHash: string) =>
  createRepositories(testDb()).runnerEnrollment.createToken(tokenHash, {});

const withStartedContainer = async () => {
  const server = await expiredApproval("devcontainer");
  const { api, plane } = server;
  await api.runs.setSandbox({ id: 1, spec: "running" });
  const sync = await plane.sync({ held: [], capacity: 0, capabilities: devcontainerRunner });
  const generation = sync.sandboxes[0]!.generation;
  const attach = { containerName: "loving_borg", containerFolder: "/workspaces/run-1" };
  await plane.reportSandbox({ workflowRunId: 1, generation, observed: "running", attach });
  return { ...server, attach };
};

const claimAfterDecision = async (server: Awaited<ReturnType<typeof expiredApproval>>) => {
  await server.api.inbox.resolve({ id: server.itemId, decision: "approve" });
  return server.claimOne([], "devcontainer");
};

const requeue = ({ workflowRunId, lease }: RunLease) =>
  createRepositories(testDb()).workflowRun.requeue(workflowRunId, lease);

const finishAttemptAfterOpen = async (checkpoint?: Checkpoint) => {
  const server = await expiredApproval("devcontainer");
  await server.api.runs.setSandbox({ id: 1, spec: "running" });
  const { lease } = await claimAfterDecision(server);
  const { attemptId } = await server.plane.startAttempt(lease, server.stepRunId);
  const done = {
    status: "succeeded",
    summary: "Done",
    ...(checkpoint && { checkpoint }),
  } as const;
  await server.plane.finishAttempt(lease, attemptId, { result: done });
  await requeue(lease);
  return server.claimOne([], "devcontainer");
};

const claimQueuedRun = async () => {
  const server = await createConnectedTestServer(testDb());
  await server.queue();
  return { ...server, claimed: await server.claimOne() };
};

const endLease = (id: number) =>
  testDb()
    .update(workflowRuns)
    .set({ leaseUntil: sql`now()` })
    .where(eq(workflowRuns.id, id));

const statusOf = async (id: number) =>
  (await testDb().select().from(workflowRuns).where(eq(workflowRuns.id, id)))[0]?.status;

describe("sweep", () => {
  it("expires a run whose item waits more than 24 hours", async () => {
    const { readStatus } = await expiredApproval();

    expect(await readStatus()).toBe("expired");
  });

  it("keeps a run whose item waits less than 24 hours", async () => {
    const { readStatus } = await waitingApproval();
    await openedHoursAgo(23);

    await sweepAll();

    expect(await readStatus()).toBe("waiting_input");
  });

  it("expires a queued run whose item waits more than 24 hours", async () => {
    const { claimed, readStatus } = await waitingApproval();
    await createRepositories(testDb()).workflowRun.requeue(1, claimed.lease.lease);
    await openedHoursAgo(25);

    await sweepAll();

    expect(await readStatus()).toBe("expired");
  });

  it("keeps a run whose overdue item is resolved", async () => {
    const { api, itemId, readStatus } = await waitingApproval();
    await api.inbox.resolve({ id: itemId, decision: "approve" });
    await openedHoursAgo(25);

    await sweepAll();

    expect(await readStatus()).toBe("running");
  });

  it("keeps a run with a message that its runner did not deliver", async () => {
    const { api, review, readStatus } = await waitingReviewQuestion();
    await api.runs.sendMessage({ id: 1, stepRunId: review, text: "Use SQLite" });
    await openedHoursAgo(25);

    await sweepAll();

    expect(await readStatus()).toBe("waiting_input");
  });

  it("leaves a waiting run with a cancel request to its runner", async () => {
    const { readStatus } = await waitingApproval();
    await createRepositories(testDb()).workflowRun.requestCancel(1);
    await openedHoursAgo(25);

    await sweepAll();

    expect(await readStatus()).toBe("waiting_input");
  });

  it("gives the runner the stopped spec of an expired run instead of the run", async () => {
    const { plane, claimed } = await expiredApproval();

    const { keep, sandboxes } = await plane.sync({
      held: [claimed.lease],
      capacity: 0,
      capabilities: worktreeRunner,
    });

    expect(keep).toEqual([]);
    expect(sandboxes).toMatchObject([{ workflowRunId: 1, spec: "stopped" }]);
  });

  it("refuses a write under the lease of an expired run", async () => {
    const { plane, claimed, readStatus } = await expiredApproval();

    await expect(plane.finishRun(claimed.lease, "cancelled")).rejects.toMatchObject({
      code: "lease_lost",
    });

    expect(await readStatus()).toBe("expired");
  });

  it("keeps the approval item of an expired run pending", async () => {
    await expiredApproval();

    expect(await testDb().select().from(inboxItems)).toMatchObject([{ resolvedAt: null }]);
  });

  it("marks the running attempt of an expired run lost", async () => {
    await expiredApproval();

    expect(await testDb().select().from(stepAttempts)).toMatchObject([{ status: "lost" }]);
  });

  it("closes the question of the attempt that an expiry ends", async () => {
    await expiredReviewQuestion();

    expect(await testDb().select().from(inboxItems)).toMatchObject([
      { resolvedAt: expect.any(Date), decision: null },
    ]);
  });

  it("signals a state change of an expired run", async () => {
    await waitingApproval();
    await openedHoursAgo(25);
    const bus = new RunBus();
    const changes: string[] = [];
    bus.subscribe(1, (change) => changes.push(change));

    await sweepAll(bus);

    expect(changes).toEqual(["state"]);
  });

  it("gives an expired run to no runner with free capacity", async () => {
    const { plane } = await expiredApproval();

    const { claimed } = await plane.sync({ held: [], capacity: 1, capabilities: worktreeRunner });

    expect(claimed).toEqual([]);
  });

  it("lets a person push the branch of an expired run", async () => {
    const { api } = await expiredApproval();

    expect(await api.runs.get({ id: 1 })).toMatchObject({ canPush: true });
  });

  it("lets a person start the container of an expired run", async () => {
    const { api } = await expiredApproval("devcontainer");

    expect(await api.runs.get({ id: 1 })).toMatchObject({ canStartSandbox: true });
  });

  it("wants the container of an expired run running when a person starts it", async () => {
    const { api, plane } = await expiredApproval("devcontainer");

    await api.runs.setSandbox({ id: 1, spec: "running" });

    const { sandboxes } = await plane.sync({
      held: [],
      capacity: 0,
      capabilities: devcontainerRunner,
    });
    expect(sandboxes).toMatchObject([{ workflowRunId: 1, spec: "running" }]);
  });

  it("wants the container of an expired run stopped when a person stops it again", async () => {
    const { api, plane } = await expiredApproval("devcontainer");
    await api.runs.setSandbox({ id: 1, spec: "running" });

    await api.runs.setSandbox({ id: 1, spec: "stopped" });

    const { sandboxes } = await plane.sync({
      held: [],
      capacity: 0,
      capabilities: devcontainerRunner,
    });
    expect(sandboxes).toMatchObject([{ workflowRunId: 1, spec: "stopped" }]);
  });

  it("gives the running container of an expired run to attach to", async () => {
    const { api, attach } = await withStartedContainer();

    expect((await api.runs.get({ id: 1 })).sandbox?.attach).toEqual(attach);
  });

  it("gives no container to attach to once a decision queues an expired run again", async () => {
    const { api, itemId } = await withStartedContainer();

    await api.inbox.resolve({ id: itemId, decision: "approve" });

    expect((await api.runs.get({ id: 1 })).sandbox?.attach).toBeUndefined();
  });

  it("does not let a person delete an expired run", async () => {
    const { api } = await expiredApproval("devcontainer");

    await expect(api.runs.delete({ id: 1 })).rejects.toMatchObject({ status: 409 });
  });

  it("does not let a person remove the sandbox of an expired run", async () => {
    const { api } = await expiredApproval("devcontainer");

    await expect(api.runs.removeSandbox({ id: 1 })).rejects.toMatchObject({
      status: 409,
      message: "Run 1 is active. Cancel it first.",
    });
  });

  it("queues an expired run again on a decision on its item", async () => {
    const { api, itemId, readStatus } = await expiredApproval();

    await api.inbox.resolve({ id: itemId, decision: "approve" });

    expect(await readStatus()).toBe("queued");
  });

  it("gives the decision to the runner that claims an expired run", async () => {
    const { api, plane, itemId } = await expiredApproval();
    await api.inbox.resolve({ id: itemId, decision: "approve" });

    const { claimed, answers } = await plane.sync({
      held: [],
      capacity: 1,
      capabilities: worktreeRunner,
    });

    expect(claimed).toMatchObject([{ lease: { workflowRunId: 1 } }]);
    expect(answers).toMatchObject([{ itemId, decision: "approve" }]);
  });

  it("tells the runner that claims an expired run that a person started its container", async () => {
    const server = await expiredApproval("devcontainer");
    await server.api.runs.setSandbox({ id: 1, spec: "running" });

    expect((await claimAfterDecision(server)).isWorkspaceOpened).toBe(true);
  });

  it("tells the runner that claims an expired run that a person started its container, after a stop", async () => {
    const server = await expiredApproval("devcontainer");
    await server.api.runs.setSandbox({ id: 1, spec: "running" });
    await server.api.runs.setSandbox({ id: 1, spec: "stopped" });

    expect((await claimAfterDecision(server)).isWorkspaceOpened).toBe(true);
  });

  it("does not tell the runner that claims an expired run of a container that no person started", async () => {
    const server = await expiredApproval("devcontainer");

    expect((await claimAfterDecision(server)).isWorkspaceOpened).toBeUndefined();
  });

  it("tells the runner that claims an expired run again after a crash", async () => {
    const server = await expiredApproval("devcontainer");
    await server.api.runs.setSandbox({ id: 1, spec: "running" });
    await requeue((await claimAfterDecision(server)).lease);

    const claimed = await server.claimOne([], "devcontainer");

    expect(claimed.isWorkspaceOpened).toBe(true);
  });

  it("does not tell the runner that claims an expired run after an attempt stored a checkpoint", async () => {
    const checkpoint = {
      before: "b".repeat(40),
      after: "c".repeat(40),
      changedFiles: [],
    };

    expect((await finishAttemptAfterOpen(checkpoint)).isWorkspaceOpened).toBeUndefined();
  });

  it("does not tell the runner that claims an expired run after an attempt that asks a person stored a checkpoint", async () => {
    const server = await expiredApproval("devcontainer");
    await server.api.runs.setSandbox({ id: 1, spec: "running" });
    const { lease } = await claimAfterDecision(server);
    const { attemptId } = await server.plane.startAttempt(lease, server.stepRunId);
    const checkpoint = {
      before: "b".repeat(40),
      after: "c".repeat(40),
      changedFiles: [],
    };
    const failed = { status: "failed", summary: "Gates failed", checkpoint } as const;
    await server.plane.askHuman(lease, attemptId, {
      result: failed,
      kind: "ask_human",
      message: "Help",
    });
    await requeue(lease);

    expect((await server.claimOne([], "devcontainer")).isWorkspaceOpened).toBeUndefined();
  });

  it("tells the runner that claims an expired run after an attempt without a checkpoint", async () => {
    expect((await finishAttemptAfterOpen()).isWorkspaceOpened).toBe(true);
  });

  it("queues an expired run again on a message to its running step", async () => {
    const { api, review, readStatus } = await expiredReviewQuestion();

    await api.runs.sendMessage({ id: 1, stepRunId: review, text: "Use SQLite" });

    expect(await readStatus()).toBe("queued");
  });

  it("queues an expired run again on a reopen of a finished step", async () => {
    const { api, implement, readStatus } = await expiredReviewQuestion();

    await api.runs.sendMessage({ id: 1, stepRunId: implement, text: "Use SQLite" });

    expect(await readStatus()).toBe("queued");
  });

  it("cancels an expired run at once", async () => {
    const { api, readStatus } = await expiredApproval();

    await api.runs.cancel({ id: 1 });

    expect(await readStatus()).toBe("cancelled");
  });

  it("closes the item of an expired run when it is cancelled", async () => {
    const { api } = await expiredApproval();

    await api.runs.cancel({ id: 1 });

    expect(await testDb().select().from(inboxItems)).toMatchObject([
      { resolvedAt: expect.any(Date) },
    ]);
  });

  it("removes the sandbox of a run that finished more than 24 hours ago", async () => {
    await finishedRun(25);

    await sweepAll();

    expect(await specOfRun()).toBe("destroyed");
  });

  it("keeps the sandbox of a run that finished less than 24 hours ago", async () => {
    await finishedRun(23);

    await sweepAll();

    expect(await specOfRun()).toBe("stopped");
  });

  it("counts the TTL again from a start of the container", async () => {
    const { api } = await finishedRunIn("devcontainer", 25);

    await api.runs.setSandbox({ id: 1, spec: "running" });
    await sweepAll();

    expect(await specOfRun()).toBe("running");
  });

  it("removes the sandbox of a run that expired more than 24 hours ago", async () => {
    const { waitForApproval } = await createConnectedTestServer(testDb());
    await waitForApproval();
    await testDb()
      .update(inboxItems)
      .set({ createdAt: sql`now() - make_interval(hours => 25)` });
    await sweepAll();
    await testDb()
      .update(workflowRuns)
      .set({ sandboxKeptAt: sql`now() - make_interval(hours => 25)` })
      .where(eq(workflowRuns.id, 1));

    await sweepAll();

    expect(await specOfRun()).toBe("destroyed");
  });

  it("keeps the sandbox of a reopened run", async () => {
    const { api, plane, startAgentStep } = await createConnectedTestServer(testDb());
    const { claimed, stepRunId, attemptId } = await startAgentStep();
    await plane.finishAttempt(claimed.lease, attemptId, {
      result: { status: "succeeded" },
      stepResult: {
        status: "succeeded",
      },
    });
    await plane.finishRun(claimed.lease, "succeeded");
    await finishedHoursAgo(25);
    await api.runs.sendMessage({ id: 1, stepRunId, text: "Use SQLite" });

    await sweepAll();

    expect(await specOfRun()).toBe("stopped");
  });

  it("signals a state change of a run whose sandbox it removes", async () => {
    await finishedRun(25);
    const bus = new RunBus();
    const changes: string[] = [];
    bus.subscribe(1, (change) => changes.push(change));

    await sweepAll(bus);

    expect(changes).toEqual(["state"]);
  });

  it("signals nothing for a run whose sandbox is already removed", async () => {
    const { api } = await finishedRun(25);
    await api.runs.removeSandbox({ id: 1 });
    const bus = new RunBus();
    const changes: string[] = [];
    bus.subscribe(1, (change) => changes.push(change));

    await sweepAll(bus);

    expect(changes).toEqual([]);
  });

  it.each([
    [8, 0],
    [6, 1],
  ])("after %i days leaves %i GitHub deliveries", async (days, count) => {
    await testDb()
      .insert(gitHubDeliveries)
      .values({
        deliveryId: "delivery-1",
        event: "issues",
        startedAt: sql`now() - make_interval(days => ${days})`,
      });

    await sweepAll();

    expect(await testDb().select().from(gitHubDeliveries)).toHaveLength(count);
  });

  it("deletes the calls of a run that finished more than 24 hours ago", async () => {
    await callsOfRunFinishedHoursAgo(25);

    await sweepAll();

    expect(await runCallCount()).toBe(0);
  });

  it("keeps the calls of a run that finished less than 24 hours ago", async () => {
    await callsOfRunFinishedHoursAgo(23);

    await sweepAll();

    expect(await runCallCount()).toBe(1);
  });

  it("keeps the calls of a run that has not finished", async () => {
    const { queue, claimOne } = await createConnectedTestServer(testDb());
    await queue();
    await claimOne();
    await addRunCall();

    await sweepAll();

    expect(await runCallCount()).toBe(1);
  });

  it("deletes an expired enrollment", async () => {
    await addToken("expired");
    await testDb()
      .update(runnerEnrollments)
      .set({ expiresAt: sql`now() - interval '1 minute'` });

    await sweepAll();

    expect(await testDb().select().from(runnerEnrollments)).toEqual([]);
  });

  it("keeps an open enrollment", async () => {
    await addToken("open");

    await sweepAll();

    expect(await testDb().select().from(runnerEnrollments)).toMatchObject([{ tokenHash: "open" }]);
  });

  it("deletes old rows after a failed job", async () => {
    await callsOfRunFinishedHoursAgo(25);
    vi.spyOn(WorkflowRunRepository.prototype, "lockExpired").mockRejectedValue(new Error("down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await sweepAll();

    expect(await runCallCount()).toBe(0);
    expect(logged).toHaveBeenCalledWith(new Error("down"));
  });

  it("queues again the runs whose lease expired, of every process", async () => {
    const { planeOf, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue();
    await queue();
    const own = await claimOne();
    const [other] = (
      await planeOf("other").sync({ held: [], capacity: 1, capabilities: worktreeRunner })
    ).claimed;
    if (!other) throw new Error("No run was claimed");
    await endLease(own.lease.workflowRunId);
    await endLease(other.lease.workflowRunId);

    await sweepAll();

    expect(await statusOf(own.lease.workflowRunId)).toBe("queued");
    expect(await statusOf(other.lease.workflowRunId)).toBe("queued");
  });

  it("marks the running attempt of a run with an expired lease lost", async () => {
    const { plane, claimed } = await claimQueuedRun();
    const stepRunId = await plane.startStep(claimed.lease, "build");
    await plane.startAttempt(claimed.lease, stepRunId);
    await endLease(claimed.lease.workflowRunId);

    await sweepAll();

    expect(await testDb().select().from(stepAttempts)).toMatchObject([
      { status: "lost", finishedAt: expect.any(Date) },
    ]);
  });

  it("leaves a run with a lease that did not expire", async () => {
    const { claimed } = await claimQueuedRun();

    await sweepAll();

    expect(await statusOf(claimed.lease.workflowRunId)).toBe("running");
  });

  it("cancels a run with an expired lease and a cancel request", async () => {
    const { claimed } = await claimQueuedRun();
    const { workflowRunId } = claimed.lease;
    await createRepositories(testDb()).workflowRun.requestCancel(workflowRunId);
    await endLease(workflowRunId);

    await sweepAll();

    expect(await statusOf(workflowRunId)).toBe("cancelled");
  });

  it("signals a state change of a run with an expired lease", async () => {
    const { claimed } = await claimQueuedRun();
    const { workflowRunId } = claimed.lease;
    await endLease(workflowRunId);
    const bus = new RunBus();
    const changes: string[] = [];
    bus.subscribe(workflowRunId, (change) => changes.push(change));

    await sweepAll(bus);

    expect(changes).toEqual(["state"]);
  });

  it("fails an open agent test of a runner that has not synced for a lease length", async () => {
    const { readTest, runnerId } = await requestedAgentTest(testDb());
    await testDb()
      .update(runners)
      .set({ lastSeenAt: sql`now() - interval '1 minute'` })
      .where(eq(runners.id, runnerId));

    await sweepAll();

    expect(await readTest()).toMatchObject({ status: "failed" });
  });

  it("fails a running agent test past the cap, when its runner still syncs", async () => {
    const { plane, readTest } = await runningAgentTest(testDb());
    await syncRunner(plane, devcontainerRunner, { canTest: false });
    await testDb()
      .update(agentTests)
      .set({ updatedAt: sql`now() - interval '1 hour'` });

    await sweepAll();

    expect(await readTest()).toMatchObject({ status: "failed" });
  });

  it("keeps an open agent test of a runner that synced", async () => {
    const { plane, readTest } = await runningAgentTest(testDb());
    await syncRunner(plane, devcontainerRunner, { canTest: false });

    await sweepAll();

    expect(await readTest()).toMatchObject({ status: "running" });
  });
});
