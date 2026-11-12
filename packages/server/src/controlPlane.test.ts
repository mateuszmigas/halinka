import { randomBytes } from "node:crypto";

import {
  type AttemptItemKind,
  type AttemptResult,
  type ClaimedRun,
  type ControlPlane,
  maxRunErrorLength,
  type RunnerCapabilities,
  type RunEvent,
  type RunLease,
} from "@halinka/protocol";
import { testBuild } from "@halinka/protocol/testing";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { ServerControlPlane } from "./controlPlane";
import { createRepositories } from "./db/repositories";
import {
  agentMessages,
  inboxItems,
  runners,
  stepAttempts,
  stepRuns,
  workflowRunEvents,
  workflowRuns,
} from "./db/schema";
import { defaultLeaseTimes } from "./leaseTimes";
import { RunBus } from "./runBus";
import { credentialPlace, repoSecretPlace, SecretCipher } from "./secrets";
import { GitHubAppService } from "./services/githubAppService";
import {
  agentPrompt,
  answeringPrompt,
  baseSha,
  connectApp,
  createConnectedTestServer,
  deliveringPrompt,
  devcontainerConfig,
  devcontainerRunner,
  FakeGitHub,
  implementWorkflow,
  installationOf,
  makeGitHubRepo,
  publishSteps,
  publishWorkflow,
  recordChanges,
  registerTestRunner,
  repoOf,
  repoPath,
  requestedAgentTest,
  runningAgentTest,
  setUpTestDb,
  syncRunner,
  testCheckpoint,
  testCipher,
  testKeyOf,
  testQuestions,
  testRunnerPackage,
  worktreeRunner,
} from "./testing";

const testDb = setUpTestDb();

type Connected = Awaited<ReturnType<typeof connect>>;

const connect = async () => {
  const db = testDb();
  const {
    bus,
    plane,
    planeOf,
    api,
    files,
    queue,
    claimOne,
    waitForApproval,
    waitForGate,
    waitForQuestion,
    startAgentStep,
  } = await createConnectedTestServer(db);
  const readStatus = async (id: number) =>
    (await db.select().from(workflowRuns).where(eq(workflowRuns.id, id)))[0]?.status;
  const requestCancel = (id: number) => createRepositories(db).workflowRun.requestCancel(id);
  const requeue = ({ workflowRunId, lease }: RunLease) =>
    createRepositories(db).workflowRun.requeue(workflowRunId, lease);
  const endLeaseIn = (id: number, seconds: number) =>
    db
      .update(workflowRuns)
      .set({ leaseUntil: sql`now() + make_interval(secs => ${seconds})` })
      .where(eq(workflowRuns.id, id));
  const readLeaseSeconds = async (id: number) => {
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id));
    if (!run?.leaseUntil) throw new Error(`Run ${id} has no lease end`);
    return (run.leaseUntil.getTime() - Date.now()) / 1000;
  };
  return {
    db,
    bus,
    plane,
    planeOf,
    api,
    files,
    queue,
    claimOne,
    waitForApproval,
    waitForGate,
    waitForQuestion,
    startAgentStep,
    readStatus,
    requestCancel,
    requeue,
    endLeaseIn,
    readLeaseSeconds,
  };
};

const nothing = { keep: [], claimed: [], answers: [], messages: [], sandboxes: [] };

// A run that ended has `stopped` as its second spec.
const sandboxOf = (workflowRunId: number, spec: "running" | "stopped") => ({
  workflowRunId,
  kind: "worktree",
  repoPath,
  baseSha,
  definitionSha: baseSha,
  spec,
  generation: spec === "running" ? 1 : 2,
});

const onlySandboxOf = (workflowRunId: number, spec: "running" | "stopped") => ({
  ...nothing,
  sandboxes: [sandboxOf(workflowRunId, spec)],
});

const buildSteps = "steps:\n  - id: build\n    type: shell\n    run: ls\n";

// A process of another runner with the same instance id as the test process.
const otherRunnerPlane = async (db: ReturnType<typeof testDb>) => {
  const other = await registerTestRunner(db, "other");
  return new ServerControlPlane(
    { runnerId: other.id, instanceId: "test", publicKey: testKeyOf("other") },
    {
      db,
      serverBuild: { buildId: testBuild.id, hasPackage: true },
      bus: new RunBus(),
      leaseSeconds: defaultLeaseTimes.leaseSeconds,
      cipher: testCipher,
      gitHubApp: new GitHubAppService(db, createRepositories(db), testCipher),
    },
  );
};

const claimQueuedRun = async () => {
  const server = await connect();
  await server.queue();
  return { ...server, claimed: await server.claimOne() };
};

const unlistedRun = async () => {
  const server = await claimQueuedRun();
  const stepRunId = await server.plane.startStep(server.claimed.lease, "build");
  await server.plane.startAttempt(server.claimed.lease, stepRunId);
  return { ...server, stepRunId };
};

// A finished agent step in a devcontainer run, so a message reopens the run.
const finishedContainerRun = async () => {
  const server = await createConnectedTestServer(testDb());
  const { api, plane, files, claimOne } = server;
  files[".halinka/config.yml"] = devcontainerConfig;
  files[".halinka/workflows/implement.yml"] = implementWorkflow;
  await api.runs.create({ repoId: 1, workflow: "implement" });
  const claimed = await claimOne([], "devcontainer");
  const stepRunId = await plane.startStep(claimed.lease, "implement");
  const { attemptId } = await plane.startAttempt(claimed.lease, stepRunId);
  const succeeded = { status: "succeeded" } as const;
  await plane.finishAttempt(claimed.lease, attemptId, { result: succeeded, stepResult: succeeded });
  await plane.finishRun(claimed.lease, "succeeded");
  await api.runs.removeSandbox({ id: 1 });
  const reopen = () => api.runs.sendMessage({ id: 1, stepRunId, text: "again" });
  return { ...server, reopen };
};

const reclaimedStepsAfter = async (results: AttemptResult[]) => {
  const { plane, claimOne, requeue, claimed } = await claimQueuedRun();
  const stepRunId = await plane.startStep(claimed.lease, "implement");
  for (const result of results) {
    const { attemptId } = await plane.startAttempt(claimed.lease, stepRunId);
    await plane.finishAttempt(claimed.lease, attemptId, { result });
  }
  await requeue(claimed.lease);
  return (await claimOne()).steps;
};

const agentSession = (attemptId: number, sessionId: string): RunEvent => ({
  kind: "agent_session",
  payload: { stepId: "implement", attemptId, sessionId },
});

const claimRunningAttempt = async () => {
  const server = await claimQueuedRun();
  const stepRunId = await server.plane.startStep(server.claimed.lease, "implement");
  const { attemptId } = await server.plane.startAttempt(server.claimed.lease, stepRunId);
  return { ...server, stepRunId, attemptId };
};

const setInputMebibytes = async (db: ReturnType<typeof testDb>, id: number, mebibytes: number) =>
  db
    .update(workflowRuns)
    .set({ inputs: { text: "x".repeat(mebibytes * 1024 * 1024) } })
    .where(eq(workflowRuns.id, id));

const readRun = async (db: ReturnType<typeof testDb>, id: number) =>
  (await db.select().from(workflowRuns).where(eq(workflowRuns.id, id)))[0];

const finishedRun = async () => {
  const server = await claimQueuedRun();
  await server.plane.finishRun(server.claimed.lease, "succeeded");
  return server;
};

const stoppedReport = { workflowRunId: 1, generation: 2, observed: "stopped" } as const;

const answered = [{ selected: ["SQLite"], other: null }];

const claimAgain = async ({ plane, claimOne }: Pick<Connected, "plane" | "claimOne">) => {
  await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });
  const { steps } = await claimOne();
  return steps.at(-1)?.told;
};

const withMessage = async () => {
  const server = await connect();
  const started = await server.startAgentStep();
  const { stepRunId } = started;
  const { id: messageId } = await server.api.runs.sendMessage({
    id: 1,
    stepRunId,
    text: "Use SQLite",
  });
  return { ...server, ...started, messageId };
};

const syncHeld = (plane: ControlPlane, lease: RunLease) =>
  plane.sync({ held: [lease], capacity: 0, capabilities: worktreeRunner });

const askHumanFor = (
  { plane, claimed, attemptId }: Awaited<ReturnType<typeof withMessage>>,
  kind: AttemptItemKind = "ask_human",
) =>
  plane.askHuman(claimed.lease, attemptId, {
    result: { status: "failed" },
    kind,
    message: "Decide.",
  });

const waitForLimit = async ({
  plane,
  queue,
  claimOne,
  requeue,
}: Awaited<ReturnType<typeof connect>>) => {
  await queue();
  const claimed = await claimOne();
  const stepRunId = await plane.startStep(claimed.lease, "implement");
  const { attemptId } = await plane.startAttempt(claimed.lease, stepRunId);
  const itemId = await plane.askHuman(claimed.lease, attemptId, {
    result: { status: "stopped", summary: "Stopped" },
    kind: "limit",
    message: "The agent reached max_turns.",
  });
  await requeue(claimed.lease);
  return itemId;
};

const syncedQueuedRun = async () => {
  const context = await connect();
  const id = await context.queue();
  await context.plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });
  return { ...context, changes: recordChanges(context.bus, id) };
};

const syncedSandboxes = async ({ plane }: { plane: ControlPlane }) =>
  (await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner })).sandboxes;

const finishedRunWithBranch = async () => {
  const context = await connect();
  await context.queue();
  const { lease } = await context.claimOne();
  await context.plane.branchCreated(lease);
  await context.plane.finishRun(lease, "succeeded");
  return context;
};

const key = { preset: "claude-code", variable: "ANTHROPIC_API_KEY" };
const stored = { variable: key.variable, value: "sk-ant-stored-value" };

describe("finishRun", () => {
  it("stores the error of a run that failed outside its steps", async () => {
    const { api, plane, claimed } = await claimQueuedRun();

    await plane.finishRun(claimed.lease, "failed", "The devcontainer did not start");

    expect(await api.runs.get({ id: 1 })).toMatchObject({
      status: "failed",
      error: "The devcontainer did not start",
    });
  });

  it("cuts a long run error to 8000 characters", async () => {
    const { api, plane, claimed } = await claimQueuedRun();

    await plane.finishRun(claimed.lease, "failed", "x".repeat(9000));

    expect((await api.runs.get({ id: 1 })).error).toHaveLength(8000);
  });

  it("refuses a write under a lease that is not held", async () => {
    const { plane, claimed } = await claimQueuedRun();
    const { workflowRunId } = claimed.lease;

    await expect(
      plane.finishRun({ workflowRunId, lease: "another-lease" }, "failed"),
    ).rejects.toMatchObject({ code: "lease_lost" });
    await plane.finishRun(claimed.lease, "succeeded");
    await expect(plane.finishRun(claimed.lease, "failed")).rejects.toMatchObject({
      code: "lease_lost",
    });
  });

  it("refuses a write under an expired lease", async () => {
    const { plane, endLeaseIn, claimed } = await claimQueuedRun();
    await endLeaseIn(claimed.lease.workflowRunId, 0);

    await expect(plane.finishRun(claimed.lease, "failed")).rejects.toMatchObject({
      code: "lease_lost",
    });
  });

  it("refuses a succeeded run that still has a running step", async () => {
    const { db, plane, claimed } = await claimQueuedRun();
    await plane.startStep(claimed.lease, "build");

    await expect(plane.finishRun(claimed.lease, "succeeded")).rejects.toMatchObject({
      code: "result_refused",
    });
    expect(await db.select({ status: workflowRuns.status }).from(workflowRuns)).toEqual([
      { status: "running" },
    ]);
  });

  it.each([
    ["cancelled", "cancelled"],
    ["failed", "lost"],
  ] as const)(
    "ends the open step runs and attempts with a %s run",
    async (result, attemptStatus) => {
      const { db, plane, claimed } = await claimQueuedRun();
      const stepRunId = await plane.startStep(claimed.lease, "build");
      await plane.startAttempt(claimed.lease, stepRunId);

      await plane.finishRun(claimed.lease, result);

      expect(await db.select().from(stepRuns)).toMatchObject([
        { status: result, finishedAt: expect.any(Date) },
      ]);
      expect(await db.select().from(stepAttempts)).toMatchObject([
        { status: attemptStatus, finishedAt: expect.any(Date) },
      ]);
    },
  );

  it("fails a run whose result the server cannot store, so it is not queued again", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, api, plane, claimed } = await claimQueuedRun();
    await db.execute(sql`alter table run_calls rename to run_calls_gone`);
    onTestFinished(async () => {
      await db.execute(sql`alter table run_calls_gone rename to run_calls`);
    });

    const finishing = plane.finishRun({ ...claimed.lease, callId: "finish-1" }, "succeeded");

    await expect(finishing).rejects.toThrow('Failed query: insert into "run_calls"');
    expect(
      (await plane.sync({ held: [], capacity: 1, capabilities: worktreeRunner })).claimed,
    ).toEqual([]);
    expect(await api.runs.get({ id: 1 })).toMatchObject({
      status: "failed",
      error: expect.stringContaining('The server did not store the result "succeeded" of the run'),
    });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('insert into "run_calls"') }),
    );
  });

  it("refuses a write of another runner under the lease of a run", async () => {
    const { db, claimed } = await claimQueuedRun();
    const otherPlane = await otherRunnerPlane(db);

    await expect(otherPlane.finishRun(claimed.lease, "failed")).rejects.toMatchObject({
      code: "lease_lost",
    });
  });

  it("answers a repeat of the call that finished the run", async () => {
    const { plane, claimed } = await claimQueuedRun();
    const call = { ...claimed.lease, callId: "finish-1" };
    await plane.finishRun(call, "failed");

    await expect(plane.finishRun(call, "failed")).resolves.toBeUndefined();
  });

  it("wants the sandbox stopped when the run ends", async () => {
    const { db } = await finishedRun();

    expect(await readRun(db, 1)).toMatchObject({ sandbox: "stopped", sandboxGeneration: 2 });
  });

  it("closes the pending items of a run that ends", async () => {
    const { db, plane, waitForApproval } = await connect();
    const { claimed } = await waitForApproval();

    await plane.finishRun(claimed.lease, "failed");

    expect(await db.select().from(inboxItems)).toMatchObject([
      { decision: null, resolvedBy: "halinka", resolvedAt: expect.any(Date) },
    ]);
  });
});

describe("reportSandbox", () => {
  it("cuts a long sandbox error to 8000 characters", async () => {
    const { api, plane, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();

    await plane.reportSandbox({ workflowRunId: 1, generation: 2, error: "x".repeat(9000) });

    expect((await api.runs.get({ id: 1 })).sandbox?.error).toHaveLength(8000);
  });

  it("stores the observed state of a report of the generation", async () => {
    const { db, plane } = await finishedRun();

    await plane.reportSandbox(stoppedReport);

    expect(await readRun(db, 1)).toMatchObject({
      sandboxObserved: "stopped",
      sandboxObservedGeneration: 2,
    });
  });

  it("ignores a report of an older generation", async () => {
    const { db, plane } = await finishedRun();

    await plane.reportSandbox({ workflowRunId: 1, generation: 1, observed: "running" });

    expect(await readRun(db, 1)).toMatchObject({ sandboxObservedGeneration: null });
  });

  it("ignores a report of a leased run", async () => {
    const { db, plane } = await claimQueuedRun();

    await plane.reportSandbox({ workflowRunId: 1, generation: 1, observed: "stopped" });

    expect(await readRun(db, 1)).toMatchObject({ sandboxObserved: null });
  });

  it("stores the error of a failed apply", async () => {
    const { db, plane } = await finishedRun();

    await plane.reportSandbox({ workflowRunId: 1, generation: 2, error: "Disk full" });

    expect(await readRun(db, 1)).toMatchObject({
      sandboxObservedGeneration: null,
      sandboxError: "Disk full",
    });
  });

  it("clears the error with a report of the generation", async () => {
    const { db, plane } = await finishedRun();
    await plane.reportSandbox({ workflowRunId: 1, generation: 2, error: "Disk full" });

    await plane.reportSandbox(stoppedReport);

    expect(await readRun(db, 1)).toMatchObject({ sandboxError: null });
  });

  it("ignores a report of another runner", async () => {
    const { db } = await finishedRun();
    const otherPlane = await otherRunnerPlane(db);

    await otherPlane.reportSandbox({ workflowRunId: 1, generation: 2, observed: "absent" });

    expect(await readRun(db, 1)).toMatchObject({ sandboxObserved: null });
  });

  it("refuses a report of a revoked runner", async () => {
    const { api, plane } = await finishedRun();
    await api.runners.revoke({ id: 1 });

    await expect(plane.reportSandbox(stoppedReport)).rejects.toMatchObject({ code: "refused" });
  });

  it("signals a state change of the run it records a report of", async () => {
    const { bus, plane } = await finishedRun();
    const changes: string[] = [];
    bus.subscribe(1, (change) => changes.push(change));

    await plane.reportSandbox(stoppedReport);

    expect(changes).toEqual(["state"]);
  });

  it("signals no change for a report that changes nothing", async () => {
    const { bus, plane } = await finishedRun();
    await plane.reportSandbox(stoppedReport);
    const changes: string[] = [];
    bus.subscribe(1, (change) => changes.push(change));

    await plane.reportSandbox(stoppedReport);

    expect(changes).toEqual([]);
  });
});

const updatableRunner = { ...worktreeRunner, canUpdate: true };

const withPackage = { runnerPackage: testRunnerPackage };

const otherBuildRunner = { ...updatableRunner, build: { version: "0.0.1", id: "other-build" } };

describe("sync", () => {
  it("asks an updatable runner to update when an Admin requested it", async () => {
    const { plane, api, runnerId } = await createConnectedTestServer(testDb(), withPackage);
    await syncRunner(plane, otherBuildRunner);
    await api.runners.requestUpdate({ id: runnerId });

    expect((await syncRunner(plane, otherBuildRunner)).update).toBe("when_idle");
  });

  it("clears the update request when the runner syncs on the build of the server", async () => {
    const { plane, api, runnerId } = await createConnectedTestServer(testDb(), withPackage);
    await syncRunner(plane, otherBuildRunner);
    await api.runners.requestUpdate({ id: runnerId, isNow: true });

    expect((await syncRunner(plane, updatableRunner)).update).toBeUndefined();
  });

  it("asks the runner to update now when an Admin interrupts its runs", async () => {
    const { plane, api, runnerId } = await createConnectedTestServer(testDb(), withPackage);
    await syncRunner(plane, otherBuildRunner);
    await api.runners.requestUpdate({ id: runnerId, isNow: true });

    expect((await syncRunner(plane, otherBuildRunner)).update).toBe("now");
  });

  it("clears the update failure when the runner syncs on the build of the server", async () => {
    const { plane, api, runnerId } = await createConnectedTestServer(testDb(), withPackage);
    await createRepositories(testDb()).runner.reportUpdateFailure(runnerId, {
      buildId: testBuild.id,
      reason: "npm install failed",
    });

    await syncRunner(plane, updatableRunner);

    expect((await api.runners.list())[0]).not.toHaveProperty("updateFailure");
  });

  it("drops an update request of a process that cannot update", async () => {
    const { plane, api, runnerId } = await createConnectedTestServer(testDb(), withPackage);
    await syncRunner(plane, otherBuildRunner);
    await api.runners.requestUpdate({ id: runnerId });

    await syncRunner(plane, { ...otherBuildRunner, canUpdate: false });

    expect((await api.runners.list())[0]).not.toHaveProperty("updateRequest");
  });

  it("asks a runner with auto-update on another build to update", async () => {
    const { plane, api, runnerId } = await createConnectedTestServer(testDb(), withPackage);
    await api.runners.update({ id: runnerId, hasAutoUpdate: true });

    expect((await syncRunner(plane, otherBuildRunner)).update).toBe("when_idle");
  });

  it("does not ask again for an auto-update that the runner reported as failed", async () => {
    const { plane, api, runnerId } = await createConnectedTestServer(testDb(), withPackage);
    await api.runners.update({ id: runnerId, hasAutoUpdate: true });
    await createRepositories(testDb()).runner.reportUpdateFailure(runnerId, {
      buildId: testBuild.id,
      reason: "npm install failed",
    });

    expect((await syncRunner(plane, otherBuildRunner)).update).toBeUndefined();
  });

  it("claims no run for a runner that waits for its update", async () => {
    const { plane, api, runnerId, queue } = await createConnectedTestServer(testDb(), withPackage);
    await syncRunner(plane, otherBuildRunner);
    await api.runners.requestUpdate({ id: runnerId });
    await queue();

    const { claimed } = await plane.sync({ held: [], capacity: 1, capabilities: otherBuildRunner });

    expect(claimed).toEqual([]);
  });

  it("gives a run with a workspace only to a runner of the workspace's kind", async () => {
    const { plane, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue("devcontainer");
    await claimOne([], "devcontainer");
    await plane.sync({ held: [], capacity: 0, capabilities: devcontainerRunner });

    expect(
      (await plane.sync({ held: [], capacity: 1, capabilities: worktreeRunner })).claimed,
    ).toEqual([]);
    expect(await claimOne([], "devcontainer")).toMatchObject({ lease: { workflowRunId: 1 } });
  });

  it("gives no run to a devcontainer runner without Docker", async () => {
    const { plane, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue("devcontainer");
    const noDocker: RunnerCapabilities = { ...devcontainerRunner, hasDocker: false };

    expect((await plane.sync({ held: [], capacity: 1, capabilities: noDocker })).claimed).toEqual(
      [],
    );
    expect(await claimOne([], "devcontainer")).toMatchObject({ lease: { workflowRunId: 1 } });
  });

  it("gives a run of a repo without a devcontainer only to a worktree runner", async () => {
    const { plane, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue();

    expect(
      (await plane.sync({ held: [], capacity: 1, capabilities: devcontainerRunner })).claimed,
    ).toEqual([]);
    expect(await claimOne()).toMatchObject({ lease: { workflowRunId: 1 } });
  });

  it("gives an agent run to a worktree runner only when the agent is on its PATH", async () => {
    const { plane, api, files, claimOne } = await createConnectedTestServer(testDb());
    files[".halinka/workflows/implement.yml"] = implementWorkflow;
    await api.runs.create({ repoId: 1, workflow: "implement" });
    const onlyCodex: RunnerCapabilities = { ...worktreeRunner, agentsOnPath: ["codex"] };

    expect((await plane.sync({ held: [], capacity: 1, capabilities: onlyCodex })).claimed).toEqual(
      [],
    );
    expect(await claimOne()).toMatchObject({ lease: { workflowRunId: 1 } });
  });

  it("gives the kind of the runner to a run whose sandbox the runner removed", async () => {
    const { plane, reopen, claimOne } = await finishedContainerRun();
    await plane.reportSandbox({ workflowRunId: 1, generation: 3, observed: "absent" });
    await reopen();

    expect((await claimOne([], "worktree")).sandboxKind).toBe("worktree");
  });

  it("keeps the kind of a run until the runner reports its sandbox removed", async () => {
    const { plane, reopen, claimOne } = await finishedContainerRun();
    await reopen();

    expect(
      (await plane.sync({ held: [], capacity: 1, capabilities: worktreeRunner })).claimed,
    ).toEqual([]);
    expect(await claimOne([], "devcontainer")).toMatchObject({ lease: { workflowRunId: 1 } });
  });

  it("gives a queued run to the runner, which finishes it under its lease", async () => {
    const { db, plane, claimed } = await claimQueuedRun();

    expect(claimed).toMatchObject({
      repoPath,
      branch: "halinka/run-1",
      baseSha,
      definitionSha: baseSha,
      workflow: { name: "Build" },
      steps: [],
    });
    await plane.finishRun(claimed.lease, "succeeded");

    expect(await db.select().from(workflowRuns)).toMatchObject([
      { status: "succeeded", leaseHolder: "test" },
    ]);
    expect(await plane.sync({ held: [], capacity: 1, capabilities: worktreeRunner })).toEqual(
      onlySandboxOf(1, "stopped"),
    );
  });

  it("gives a claimed run without a checkpoint its base", async () => {
    const { claimed } = await claimQueuedRun();

    expect(claimed.lastCheckpoint).toBe(baseSha);
  });

  it("gives a reclaimed run the after of its last attempt with a checkpoint", async () => {
    const { plane, requeue, claimOne, claimed } = await claimQueuedRun();
    const { lease } = claimed;
    const stepRunId = await plane.startStep(lease, "build");
    const first = await plane.startAttempt(lease, stepRunId);
    const checkpoint = { before: baseSha, after: "c1", changedFiles: [] };
    await plane.finishAttempt(lease, first.attemptId, { result: { status: "failed", checkpoint } });
    const second = await plane.startAttempt(lease, stepRunId);
    await plane.finishAttempt(lease, second.attemptId, { result: { status: "failed" } });
    await requeue(lease);

    expect((await claimOne()).lastCheckpoint).toBe("c1");
  });

  it("gives a claimed run only its own checkpoint", async () => {
    const { plane, queue, claimOne, claimed } = await claimQueuedRun();
    const { lease } = claimed;
    const stepRunId = await plane.startStep(lease, "build");
    const { attemptId } = await plane.startAttempt(lease, stepRunId);
    const checkpoint = { before: baseSha, after: "c1", changedFiles: [] };
    await plane.finishAttempt(lease, attemptId, { result: { status: "succeeded", checkpoint } });
    await queue();

    expect((await claimOne([lease])).lastCheckpoint).toBe(baseSha);
  });

  it("gives a queued run back with the step runs it already has", async () => {
    const { plane, claimOne, requeue, claimed } = await claimQueuedRun();
    const stepRunId = await plane.startStep(claimed.lease, "build");
    await plane.finishStep(claimed.lease, stepRunId, { status: "succeeded" });
    await requeue(claimed.lease);

    const resumed = await claimOne();

    expect(resumed.steps).toEqual([
      { stepRunId, stepId: "build", status: "succeeded", failedAttempts: 0 },
    ]);
    expect(resumed.lease.lease).not.toBe(claimed.lease.lease);
  });

  it("gives a queued run back with the results of its step runs", async () => {
    const { plane, claimOne, requeue, claimed } = await claimQueuedRun();
    const stepRunId = await plane.startStep(claimed.lease, "review");
    const result = { summary: "Looks good", outcome: "approve", outputs: { findings: 0 } };
    await plane.finishStep(claimed.lease, stepRunId, { status: "succeeded", ...result });
    await requeue(claimed.lease);

    const resumed = await claimOne();

    expect(resumed.steps).toEqual([
      { stepRunId, stepId: "review", status: "succeeded", failedAttempts: 0, ...result },
    ]);
  });

  it("gives a queued run back with the count of failed attempts of each step run", async () => {
    const { plane, claimOne, requeue, claimed } = await claimQueuedRun();
    const stepRunId = await plane.startStep(claimed.lease, "build");
    for (const status of ["failed", "failed", "succeeded"] as const) {
      const { attemptId } = await plane.startAttempt(claimed.lease, stepRunId);
      await plane.finishAttempt(claimed.lease, attemptId, { result: { status } });
    }
    await requeue(claimed.lease);

    const resumed = await claimOne();

    expect(resumed.steps).toMatchObject([{ stepRunId, failedAttempts: 2 }]);
  });

  it("gives a queued run back with the loop and the iteration of each child step run", async () => {
    const { plane, claimOne, requeue, claimed } = await claimQueuedRun();
    const loopStepRunId = await plane.startStep(claimed.lease, "fix_loop");
    const childId = await plane.startStep(claimed.lease, "build", {
      stepRunId: loopStepRunId,
      iteration: 2,
    });
    await requeue(claimed.lease);

    const resumed = await claimOne();

    expect(resumed.steps).toEqual([
      { stepRunId: loopStepRunId, stepId: "fix_loop", status: "running", failedAttempts: 0 },
      {
        stepRunId: childId,
        stepId: "build",
        status: "running",
        failedAttempts: 0,
        parent: { stepRunId: loopStepRunId, iteration: 2 },
      },
    ]);
  });

  it("gives a queued run back with the usage of each step run, as a sum of its attempts", async () => {
    const { plane, claimOne, requeue, claimed } = await claimQueuedRun();
    const stepRunId = await plane.startStep(claimed.lease, "implement");
    for (const usage of [
      { activeMs: 1000, costUsd: 0.5 },
      { activeMs: 2000, costUsd: 1.25 },
    ]) {
      const { attemptId } = await plane.startAttempt(claimed.lease, stepRunId);
      await plane.finishAttempt(claimed.lease, attemptId, { result: { status: "failed", usage } });
    }
    await requeue(claimed.lease);

    const resumed = await claimOne();

    expect(resumed.steps).toMatchObject([{ usage: { activeMs: 3000, costUsd: 1.75 } }]);
  });

  it("gives no cost in the usage when no attempt has a cost", async () => {
    const { plane, claimOne, requeue, claimed } = await claimQueuedRun();
    const stepRunId = await plane.startStep(claimed.lease, "build");
    const { attemptId } = await plane.startAttempt(claimed.lease, stepRunId);
    await plane.finishAttempt(claimed.lease, attemptId, {
      result: {
        status: "succeeded",
        usage: { activeMs: 700 },
      },
    });
    await requeue(claimed.lease);

    const resumed = await claimOne();

    expect(resumed.steps[0]?.usage).toEqual({ activeMs: 700 });
  });

  it("gives a step run the commit and the session of its last attempt that has them", async () => {
    const steps = await reclaimedStepsAfter([
      { status: "failed", checkpoint: testCheckpoint(baseSha, "c1", []), sessionId: "s-1" },
      { status: "failed", checkpoint: testCheckpoint("c1", "c2", []), sessionId: "s-2" },
      { status: "failed" },
    ]);

    expect(steps).toMatchObject([{ commit: "c2", sessionId: "s-2" }]);
  });

  it("gives a step run no commit, session or changed files when no attempt has a checkpoint", async () => {
    const [step] = await reclaimedStepsAfter([{ status: "failed" }]);

    expect(step).not.toHaveProperty("commit");
    expect(step).not.toHaveProperty("sessionId");
    expect(step).not.toHaveProperty("changedFiles");
  });

  it("gives a step run the changed files of all its attempts, each one time", async () => {
    const steps = await reclaimedStepsAfter([
      { status: "failed", checkpoint: testCheckpoint(baseSha, "c1", ["b.ts", "a.ts"]) },
      { status: "succeeded", checkpoint: testCheckpoint("c1", "c2", ["a.ts", "c.ts"]) },
    ]);

    expect(steps[0]?.changedFiles).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("gives a step run the first 1000 changed files and the count of all", async () => {
    const files = Array.from(
      { length: 1200 },
      (_, index) => `f${String(index).padStart(4, "0")}.ts`,
    );
    const steps = await reclaimedStepsAfter([
      { status: "succeeded", checkpoint: testCheckpoint(baseSha, "c1", files) },
    ]);

    expect(steps[0]).toMatchObject({
      changedFiles: files.slice(0, 1000),
      changedFileCount: 1200,
    });
  });

  it("does not count a lost attempt as a failed attempt", async () => {
    const { plane, claimOne, requeue, claimed } = await claimQueuedRun();
    const stepRunId = await plane.startStep(claimed.lease, "build");
    await plane.startAttempt(claimed.lease, stepRunId);
    const { attemptId } = await plane.startAttempt(claimed.lease, stepRunId);
    await plane.finishAttempt(claimed.lease, attemptId, { result: { status: "failed" } });
    await requeue(claimed.lease);

    const resumed = await claimOne();

    expect(resumed.steps).toMatchObject([{ stepRunId, failedAttempts: 1 }]);
  });

  it("claims queued runs up to the capacity, oldest first", async () => {
    const { plane, queue } = await connect();
    const first = await queue();
    const second = await queue();
    await queue();

    const { keep, claimed } = await plane.sync({
      held: [],
      capacity: 2,
      capabilities: worktreeRunner,
    });

    expect(keep).toEqual([]);
    expect(claimed.map(({ lease }) => lease.workflowRunId)).toEqual([first, second]);
    expect(
      (await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner })).claimed,
    ).toEqual([]);
  });

  it("keeps the session of a finished attempt at a later agent_session event", async () => {
    const { plane, claimOne, requeue, claimed, attemptId } = await claimRunningAttempt();
    await plane.finishAttempt(claimed.lease, attemptId, {
      result: { status: "failed", sessionId: "s-1" },
    });

    await plane.appendEvents(claimed.lease, {
      batchId: "b1",
      events: [agentSession(attemptId, "s-2")],
    });
    await requeue(claimed.lease);

    expect((await claimOne()).steps[0]).toMatchObject({ sessionId: "s-1" });
  });

  it("counts the cost of a replaced session for a lost attempt", async () => {
    const { plane, claimOne, requeue, claimed, attemptId } = await claimRunningAttempt();
    const replaced: RunEvent = {
      kind: "agent_session",
      payload: { stepId: "implement", attemptId, sessionId: "s-2", replacedCostUsd: 3 },
    };

    await plane.appendEvents(claimed.lease, { batchId: "b1", events: [replaced] });
    await requeue(claimed.lease);

    expect((await claimOne()).steps[0]?.usage).toMatchObject({ costUsd: 3 });
  });

  it("ignores an agent_session event of an attempt of another run", async () => {
    const { plane, queue, requeue } = await connect();
    await queue();
    await queue();
    const { claimed } = await plane.sync({
      held: [],
      capacity: 2,
      capabilities: worktreeRunner,
    });
    const [first, second] = claimed as [ClaimedRun, ClaimedRun];
    const stepRunId = await plane.startStep(second.lease, "implement");
    const { attemptId } = await plane.startAttempt(second.lease, stepRunId);

    await plane.appendEvents(first.lease, {
      batchId: "b1",
      events: [agentSession(attemptId, "s-1")],
    });
    await requeue(second.lease);

    const again = await plane.sync({
      held: [first.lease],
      capacity: 1,
      capabilities: worktreeRunner,
    });
    expect(again.claimed[0]?.steps[0]).not.toHaveProperty("sessionId");
  });

  it("gives a requeued running step the cost of its session, without a session that it replaced", async () => {
    const { plane, claimOne, requeue, claimed, stepRunId, attemptId } = await claimRunningAttempt();
    await plane.finishAttempt(claimed.lease, attemptId, {
      result: {
        status: "failed",
        sessionId: "s-1",
        sessionCostUsd: 2,
        usage: { activeMs: 10, costUsd: 5 },
      },
    });
    await plane.startAttempt(claimed.lease, stepRunId);
    await requeue(claimed.lease);

    expect((await claimOne()).steps[0]).toMatchObject({ sessionCostUsd: 2 });
  });

  it("gives a finished step no session cost", async () => {
    const { plane, claimOne, requeue, claimed, stepRunId, attemptId } = await claimRunningAttempt();
    await plane.finishAttempt(claimed.lease, attemptId, {
      result: {
        status: "succeeded",
        sessionId: "s-1",
        usage: { activeMs: 10, costUsd: 2 },
      },
    });
    await plane.finishStep(claimed.lease, stepRunId, { status: "succeeded", summary: "Done" });
    await plane.startStep(claimed.lease, "build");
    await requeue(claimed.lease);

    expect((await claimOne()).steps[0]).not.toHaveProperty("sessionCostUsd");
  });

  it("gives a requeued run the session of a lost attempt", async () => {
    const { plane, claimOne, requeue, claimed, attemptId } = await claimRunningAttempt();
    await plane.appendEvents(claimed.lease, {
      batchId: "b1",
      events: [agentSession(attemptId, "s-1")],
    });
    await requeue(claimed.lease);

    expect((await claimOne()).steps[0]).toMatchObject({ sessionId: "s-1" });
  });

  it("gives no session cost for a session with only a lost attempt", async () => {
    const { plane, claimOne, requeue, claimed, attemptId } = await claimRunningAttempt();
    await plane.appendEvents(claimed.lease, {
      batchId: "b1",
      events: [agentSession(attemptId, "s-1")],
    });
    await requeue(claimed.lease);

    expect((await claimOne()).steps[0]).not.toHaveProperty("sessionCostUsd");
  });

  it("leaves a run that does not fit the answer queued for the next sync", async () => {
    const { db, plane, queue, readStatus } = await connect();
    const first = await queue();
    const second = await queue();
    await setInputMebibytes(db, first, 5);
    await setInputMebibytes(db, second, 5);

    const { claimed } = await plane.sync({
      held: [],
      capacity: 2,
      capabilities: worktreeRunner,
    });

    expect(claimed.map(({ lease }) => lease.workflowRunId)).toEqual([first]);
    expect(await readStatus(second)).toBe("queued");
  });

  it("claims the run that did not fit in the next sync", async () => {
    const { db, plane, queue } = await connect();
    const first = await queue();
    const second = await queue();
    await setInputMebibytes(db, first, 5);
    await setInputMebibytes(db, second, 5);
    const [kept] = (await plane.sync({ held: [], capacity: 2, capabilities: worktreeRunner }))
      .claimed;

    const { claimed } = await plane.sync({
      held: [kept!.lease],
      capacity: 1,
      capabilities: worktreeRunner,
    });

    expect(claimed.map(({ lease }) => lease.workflowRunId)).toEqual([second]);
  });

  it("claims the next run after it fails a run that does not fit", async () => {
    const { db, plane, queue } = await connect();
    const tooLarge = await queue();
    const next = await queue();
    await setInputMebibytes(db, tooLarge, 9);

    const { claimed } = await plane.sync({
      held: [],
      capacity: 1,
      capabilities: worktreeRunner,
    });

    expect(claimed.map(({ lease }) => lease.workflowRunId)).toEqual([next]);
  });

  it("fails a run that alone does not fit the answer", async () => {
    const { db, api, plane, queue } = await connect();
    const id = await queue();
    await setInputMebibytes(db, id, 9);

    const { claimed } = await plane.sync({
      held: [],
      capacity: 1,
      capabilities: worktreeRunner,
    });

    expect(claimed).toEqual([]);
    expect(await api.runs.get({ id })).toMatchObject({
      status: "failed",
      error: expect.stringContaining("more than a runner can get"),
    });
  });

  it("keeps the held runs whose lease is valid", async () => {
    const { plane, queue, claimOne } = await connect();
    await queue();
    await queue();
    const kept = await claimOne();
    const finished = await claimOne([kept.lease]);
    await plane.finishRun(finished.lease, "succeeded");

    const { keep } = await plane.sync({
      held: [kept.lease, finished.lease],
      capacity: 0,
      capabilities: worktreeRunner,
    });

    expect(keep).toEqual([kept.lease.workflowRunId]);
  });

  it("leases a claimed run for 30 seconds", async () => {
    const { readLeaseSeconds, claimed } = await claimQueuedRun();

    const seconds = await readLeaseSeconds(claimed.lease.workflowRunId);

    expect(seconds).toBeGreaterThan(25);
    expect(seconds).toBeLessThanOrEqual(30);
  });

  it("renews the lease of a held run", async () => {
    const { plane, endLeaseIn, readLeaseSeconds, claimed } = await claimQueuedRun();
    const { workflowRunId } = claimed.lease;
    await endLeaseIn(workflowRunId, 1);

    await plane.sync({ held: [claimed.lease], capacity: 0, capabilities: worktreeRunner });

    expect(await readLeaseSeconds(workflowRunId)).toBeGreaterThan(25);
  });

  it("keeps the renewed leases when a claim fails", async () => {
    const { db, plane, queue, endLeaseIn, readLeaseSeconds, claimed } = await claimQueuedRun();
    const { workflowRunId } = claimed.lease;
    await endLeaseIn(workflowRunId, 1);
    await queue();
    await db.execute(sql`alter table run_calls rename to run_calls_gone`);
    onTestFinished(async () => {
      await db.execute(sql`alter table run_calls_gone rename to run_calls`);
    });

    const sync = plane.sync({ held: [claimed.lease], capacity: 1, capabilities: worktreeRunner });

    await expect(sync).rejects.toThrow('Failed query: delete from "run_calls"');
    expect(await readLeaseSeconds(workflowRunId)).toBeGreaterThan(25);
  });

  it("renews the lease of a held run with a cancel request, so it can finish", async () => {
    const { plane, requestCancel, endLeaseIn, readLeaseSeconds, claimed } = await claimQueuedRun();
    const { workflowRunId } = claimed.lease;
    await requestCancel(workflowRunId);
    await endLeaseIn(workflowRunId, 1);

    await plane.sync({ held: [claimed.lease], capacity: 0, capabilities: worktreeRunner });

    expect(await readLeaseSeconds(workflowRunId)).toBeGreaterThan(25);
  });

  it("queues again a held run whose lease expired", async () => {
    const { plane, readStatus, endLeaseIn, claimed } = await claimQueuedRun();
    const { workflowRunId } = claimed.lease;
    await endLeaseIn(workflowRunId, 0);

    expect(
      await plane.sync({ held: [claimed.lease], capacity: 1, capabilities: worktreeRunner }),
    ).toEqual(onlySandboxOf(workflowRunId, "running"));
    expect(await readStatus(workflowRunId)).toBe("queued");
  });

  it("does not keep a held run with a cancel request", async () => {
    const { plane, requestCancel, claimed } = await claimQueuedRun();
    await requestCancel(claimed.lease.workflowRunId);

    expect(
      await plane.sync({ held: [claimed.lease], capacity: 1, capabilities: worktreeRunner }),
    ).toEqual(nothing);
  });

  it("leaves a held run with a cancel request running", async () => {
    const { plane, readStatus, requestCancel, claimed } = await claimQueuedRun();
    const { workflowRunId } = claimed.lease;
    await requestCancel(workflowRunId);

    await plane.sync({ held: [claimed.lease], capacity: 1, capabilities: worktreeRunner });

    expect(await readStatus(workflowRunId)).toBe("running");
  });

  it("never claims a held run", async () => {
    const { plane, requeue, claimed } = await claimQueuedRun();
    await requeue(claimed.lease);

    expect(
      await plane.sync({ held: [claimed.lease], capacity: 1, capabilities: worktreeRunner }),
    ).toEqual(onlySandboxOf(1, "running"));
  });

  it("queues again a run the process holds but did not list", async () => {
    const { plane, readStatus, claimed } = await unlistedRun();
    const { workflowRunId } = claimed.lease;

    expect(await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner })).toEqual(
      onlySandboxOf(workflowRunId, "running"),
    );

    expect(await readStatus(workflowRunId)).toBe("queued");
    await expect(plane.startStep(claimed.lease, "build")).rejects.toMatchObject({
      code: "lease_lost",
    });
  });

  it("keeps the step runs of a run that the process holds but did not list", async () => {
    const { db, plane, claimOne, stepRunId } = await unlistedRun();

    await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });

    expect(await db.select().from(stepRuns)).toMatchObject([{ status: "running" }]);
    expect(await db.select().from(stepAttempts)).toMatchObject([
      { status: "lost", finishedAt: expect.any(Date) },
    ]);
    expect((await claimOne()).steps).toEqual([
      {
        stepRunId,
        stepId: "build",
        status: "running",
        failedAttempts: 0,
      },
    ]);
  });

  it("claims a run it gave back in the same call, under a new lease", async () => {
    const { plane, claimed } = await claimQueuedRun();
    const stepRunId = await plane.startStep(claimed.lease, "build");

    const { claimed: reclaimed } = await plane.sync({
      held: [],
      capacity: 1,
      capabilities: worktreeRunner,
    });

    expect(reclaimed).toMatchObject([
      {
        lease: { workflowRunId: claimed.lease.workflowRunId },
        steps: [{ stepRunId, status: "running" }],
      },
    ]);
    expect(reclaimed[0]?.lease.lease).not.toBe(claimed.lease.lease);
  });

  it("queues again a held run listed under a stale lease", async () => {
    const { plane, readStatus, claimed } = await claimQueuedRun();
    const { workflowRunId } = claimed.lease;

    const stale = { workflowRunId, lease: "stale-lease" };
    expect(await plane.sync({ held: [stale], capacity: 1, capabilities: worktreeRunner })).toEqual(
      onlySandboxOf(workflowRunId, "running"),
    );

    expect(await readStatus(workflowRunId)).toBe("queued");
  });

  it("claims other queued runs while it skips the held ones", async () => {
    const { plane, queue, requeue, claimed } = await claimQueuedRun();
    await requeue(claimed.lease);
    const other = await queue();

    const result = await plane.sync({
      held: [claimed.lease],
      capacity: 2,
      capabilities: worktreeRunner,
    });

    expect(result.claimed.map(({ lease }) => lease.workflowRunId)).toEqual([other]);
  });

  it("cancels a run the process holds but did not list when it has a cancel request", async () => {
    const { db, plane, readStatus, requestCancel, claimed } = await claimQueuedRun();
    const { workflowRunId } = claimed.lease;
    const stepRunId = await plane.startStep(claimed.lease, "build");
    await plane.startAttempt(claimed.lease, stepRunId);
    await requestCancel(workflowRunId);

    expect(await plane.sync({ held: [], capacity: 1, capabilities: worktreeRunner })).toEqual(
      onlySandboxOf(workflowRunId, "stopped"),
    );

    expect(await readStatus(workflowRunId)).toBe("cancelled");
    expect(await db.select().from(stepRuns)).toMatchObject([{ status: "cancelled" }]);
    expect(await db.select().from(stepAttempts)).toMatchObject([{ status: "cancelled" }]);
  });

  it("leaves the runs of another process alone", async () => {
    const { planeOf, readStatus, claimed } = await claimQueuedRun();

    expect(
      await planeOf("other").sync({
        held: [claimed.lease],
        capacity: 1,
        capabilities: worktreeRunner,
      }),
    ).toEqual(nothing);

    expect(await readStatus(claimed.lease.workflowRunId)).toBe("running");
  });

  it("leaves the runs of another runner alone when its process has the same id", async () => {
    const { db, readStatus, claimed } = await claimQueuedRun();
    const otherPlane = await otherRunnerPlane(db);

    expect(await otherPlane.sync({ held: [], capacity: 1, capabilities: worktreeRunner })).toEqual(
      nothing,
    );

    expect(await readStatus(claimed.lease.workflowRunId)).toBe("running");
  });

  it("records when the runner was last seen", async () => {
    const { db, plane } = await connect();

    await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });

    const [runner] = await db.select().from(runners);
    expect(runner?.lastSeenAt).toBeInstanceOf(Date);
  });

  it("claims no run for a draining runner", async () => {
    const { api, plane, queue } = await connect();
    await queue();
    await api.runners.update({ id: 1, state: "draining" });

    expect(
      (await plane.sync({ held: [], capacity: 1, capabilities: worktreeRunner })).claimed,
    ).toEqual([]);
  });

  it("claims no queued run that a repo delete marked", async () => {
    const { db, plane, queue } = await connect();
    await createRepositories(db).workflowRun.markDeleting(await queue());

    expect(
      (await plane.sync({ held: [], capacity: 1, capabilities: worktreeRunner })).claimed,
    ).toEqual([]);
  });

  it("keeps the held runs of a draining runner", async () => {
    const { api, plane, claimed } = await claimQueuedRun();
    await api.runners.update({ id: 1, state: "draining" });

    expect(
      (await plane.sync({ held: [claimed.lease], capacity: 1, capabilities: worktreeRunner })).keep,
    ).toEqual([1]);
  });

  it("refuses a sync of a revoked runner", async () => {
    const { api, plane } = await connect();
    await api.runners.revoke({ id: 1 });

    await expect(
      plane.sync({ held: [], capacity: 1, capabilities: worktreeRunner }),
    ).rejects.toMatchObject({
      code: "refused",
    });
  });

  it("keeps the capabilities of a runner when a revoked key syncs", async () => {
    const { api, plane, db } = await connect();
    await api.runners.revoke({ id: 1 });

    await plane.sync({ held: [], capacity: 1, capabilities: worktreeRunner }).catch(() => {});

    expect(await db.select({ sandboxKind: runners.sandboxKind }).from(runners)).toEqual([
      { sandboxKind: null },
    ]);
  });

  it("claims a later run when the runner lost a label of the oldest one", async () => {
    const { api, plane, files, queue } = await connect();
    files[".halinka/workflows/gpu.yml"] =
      `schema_version: 1\nname: Gpu\nruns-on: [gpu]\n${buildSteps}`;
    await api.runners.update({ id: 1, labels: ["gpu"] });
    await api.runs.create({ repoId: 1, workflow: "gpu" });
    await queue();
    await api.runners.update({ id: 1, labels: [] });

    const { claimed } = await plane.sync({
      held: [],
      capacity: 2,
      capabilities: worktreeRunner,
    });

    expect(claimed.map(({ lease }) => lease.workflowRunId)).toEqual([2]);
  });

  it("claims no run with an agent that the runner does not allow", async () => {
    const { api, plane, files } = await connect();
    files[".halinka/workflows/fix.yml"] =
      "schema_version: 1\nname: Fix\nsteps:\n  - { id: fix, type: agent, agent: claude-code, prompt: Fix }\n";
    await api.runs.create({ repoId: 1, workflow: "fix" });
    await api.runners.update({ id: 1, allowedAgents: ["codex"] });

    const { claimed } = await plane.sync({
      held: [],
      capacity: 1,
      capabilities: worktreeRunner,
    });

    expect(claimed).toEqual([]);
  });

  it("wants the sandbox running from the claim on", async () => {
    const { db } = await claimQueuedRun();

    expect(await readRun(db, 1)).toMatchObject({ sandbox: "running", sandboxGeneration: 1 });
  });

  it("keeps the sandbox generation when a claim does not change the spec", async () => {
    const { db, requeue, claimOne, claimed } = await claimQueuedRun();
    await requeue(claimed.lease);

    await claimOne();

    expect(await readRun(db, 1)).toMatchObject({ sandbox: "running", sandboxGeneration: 1 });
  });

  it("wants no sandbox for a run that was never claimed", async () => {
    const { api, plane, queue } = await connect();
    await queue();

    await api.runs.cancel({ id: 1 });

    expect(await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner })).toEqual(
      nothing,
    );
  });

  it("lists no sandbox of a leased run", async () => {
    const { plane, claimed } = await claimQueuedRun();

    const { sandboxes } = await plane.sync({
      held: [claimed.lease],
      capacity: 0,
      capabilities: worktreeRunner,
    });

    expect(sandboxes).toEqual([]);
  });

  it("lists no sandbox of a run of another runner", async () => {
    const { db } = await finishedRun();
    const otherPlane = await otherRunnerPlane(db);

    const { sandboxes } = await otherPlane.sync({
      held: [],
      capacity: 0,
      capabilities: worktreeRunner,
      isSweep: true,
    });

    expect(sandboxes).toEqual([]);
  });

  it("lists the sandbox no more after a report of its generation", async () => {
    const { plane } = await finishedRun();

    await plane.reportSandbox(stoppedReport);

    expect(await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner })).toEqual(
      nothing,
    );
  });

  it("lists every sandbox of the runner when asked for all", async () => {
    const { plane } = await finishedRun();
    await plane.reportSandbox(stoppedReport);

    const { sandboxes } = await plane.sync({
      held: [],
      capacity: 0,
      capabilities: worktreeRunner,
      isSweep: true,
    });

    expect(sandboxes).toEqual([sandboxOf(1, "stopped")]);
  });

  it("leaves a removed sandbox out of the list of all", async () => {
    const { db, plane } = await finishedRun();
    await db
      .update(workflowRuns)
      .set({ sandbox: "destroyed", sandboxGeneration: 3 })
      .where(eq(workflowRuns.id, 1));
    await plane.reportSandbox({ workflowRunId: 1, generation: 3, observed: "absent" });

    const { sandboxes } = await plane.sync({
      held: [],
      capacity: 0,
      capabilities: worktreeRunner,
      isSweep: true,
    });

    expect(sandboxes).toEqual([]);
  });

  it("lists a sandbox to remove in the list of all before its report", async () => {
    const { db, plane } = await finishedRun();
    await db
      .update(workflowRuns)
      .set({ sandbox: "destroyed", sandboxGeneration: 3 })
      .where(eq(workflowRuns.id, 1));

    const { sandboxes } = await plane.sync({
      held: [],
      capacity: 0,
      capabilities: worktreeRunner,
      isSweep: true,
    });

    expect(sandboxes).toMatchObject([{ workflowRunId: 1, spec: "destroyed" }]);
  });

  it("lists the sandbox again after a failed apply", async () => {
    const { plane } = await finishedRun();

    await plane.reportSandbox({ workflowRunId: 1, generation: 2, error: "Disk full" });

    expect(await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner })).toEqual(
      onlySandboxOf(1, "stopped"),
    );
  });

  it("lists an applied generation again after a failed check", async () => {
    const { plane } = await finishedRun();
    await plane.reportSandbox(stoppedReport);

    await plane.reportSandbox({ workflowRunId: 1, generation: 2, error: "Disk full" });

    expect(await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner })).toEqual(
      onlySandboxOf(1, "stopped"),
    );
  });

  it("keeps a waiting run held under its lease", async () => {
    const { plane, waitForApproval } = await connect();
    const { claimed } = await waitForApproval();

    const { keep } = await plane.sync({
      held: [claimed.lease],
      capacity: 0,
      capabilities: worktreeRunner,
    });

    expect(keep).toEqual([claimed.lease.workflowRunId]);
  });

  it("gives the decision of an approval in each sync until the step run finishes", async () => {
    const { plane, api, waitForApproval } = await connect();
    const { claimed, stepRunId, itemId } = await waitForApproval();
    const { workflowRunId } = claimed.lease;
    const held = { held: [claimed.lease], capacity: 0, capabilities: worktreeRunner };
    await api.inbox.resolve({ id: itemId, decision: "approve" });

    const answers = [{ workflowRunId, itemId, decision: "approve", resolvedBy: "local" }];
    expect((await plane.sync(held)).answers).toEqual(answers);
    expect((await plane.sync(held)).answers).toEqual(answers);
    await plane.finishStep(claimed.lease, stepRunId, { status: "succeeded" });
    expect((await plane.sync(held)).answers).toEqual([]);
  });

  it("gives no decision of a gate item after the next attempt of its step started", async () => {
    const { plane, api, waitForGate } = await connect();
    const { claimed, stepRunId, itemId } = await waitForGate();
    await api.inbox.resolve({ id: itemId, decision: "retry" });

    await plane.startAttempt(claimed.lease, stepRunId);

    expect(
      (await plane.sync({ held: [claimed.lease], capacity: 0, capabilities: worktreeRunner }))
        .answers,
    ).toEqual([]);
  });

  it("gives the decision of an approval after a resumed step started its attempt", async () => {
    const { plane, api, requeue, claimOne, waitForApproval } = await connect();
    const { claimed, stepRunId, itemId } = await waitForApproval();
    await requeue(claimed.lease);
    const { lease } = await claimOne();
    await api.inbox.resolve({ id: itemId, decision: "approve" });

    await plane.startAttempt(lease, stepRunId);

    expect(
      (await plane.sync({ held: [lease], capacity: 0, capabilities: worktreeRunner })).answers,
    ).toMatchObject([{ itemId, decision: "approve" }]);
  });

  it("gives a run that a person decided while it was queued its decision at claim", async () => {
    const { plane, api, requeue, waitForApproval } = await connect();
    const { claimed, itemId } = await waitForApproval();
    await requeue(claimed.lease);
    await api.inbox.resolve({ id: itemId, decision: "reject" });

    const { answers } = await plane.sync({ held: [], capacity: 1, capabilities: worktreeRunner });

    const { workflowRunId } = claimed.lease;
    expect(answers).toEqual([{ workflowRunId, itemId, decision: "reject", resolvedBy: "local" }]);
  });

  it("gives a running step run the item of its last attempt with the report after a requeue", async () => {
    const { requeue, claimOne, waitForGate } = await connect();
    const { claimed, itemId } = await waitForGate();
    await requeue(claimed.lease);

    const resumed = await claimOne();

    expect(resumed.steps).toMatchObject([
      { attemptItem: { itemId, kind: "ask_human", summary: "Done", outcome: "done" } },
    ]);
  });

  it("gives the answer in the sync", async () => {
    const { plane, api, waitForQuestion } = await connect();
    const { claimed, itemId } = await waitForQuestion();
    const answer = [{ selected: ["SQLite"], other: "In memory" }];
    await api.inbox.resolve({ id: itemId, answer });

    const { answers } = await plane.sync({
      held: [claimed.lease],
      capacity: 0,
      capabilities: worktreeRunner,
    });

    const { workflowRunId } = claimed.lease;
    expect(answers).toEqual([
      { workflowRunId, itemId, decision: "answered", answer, resolvedBy: "local" },
    ]);
  });

  it("gives no answer after the prompt that gives it to the agent", async () => {
    const { plane, api, waitForQuestion } = await connect();
    const { claimed, attemptId, itemId } = await waitForQuestion();
    await api.inbox.resolve({ id: itemId, answer: answered });

    await plane.appendEvents(claimed.lease, {
      batchId: "b1",
      events: [answeringPrompt(attemptId, itemId)],
    });

    expect(
      (await plane.sync({ held: [claimed.lease], capacity: 0, capabilities: worktreeRunner }))
        .answers,
    ).toEqual([]);
  });

  it("gives the delivered messages and answers at a later claim, in their order", async () => {
    const connected = await connect();
    const { plane, api, startAgentStep } = connected;
    const { claimed, attemptId, stepRunId } = await startAgentStep();
    const { id: messageId } = await api.runs.sendMessage({
      id: claimed.lease.workflowRunId,
      stepRunId,
      text: "Use SQLite",
    });
    await plane.appendEvents(claimed.lease, {
      batchId: "b1",
      events: [deliveringPrompt(attemptId, messageId)],
    });
    const itemId = await plane.askQuestion(claimed.lease, attemptId, testQuestions);
    await api.inbox.resolve({ id: itemId, answer: answered });
    await plane.appendEvents(claimed.lease, {
      batchId: "b2",
      events: [answeringPrompt(attemptId, itemId)],
    });

    expect(await claimAgain(connected)).toEqual([
      { author: "local", text: "Use SQLite" },
      { questions: testQuestions, answer: answered },
    ]);
  });

  it("gives no answer that the agent did not get", async () => {
    const connected = await connect();
    const { plane, api, startAgentStep } = connected;
    const { claimed, attemptId } = await startAgentStep();
    const itemId = await plane.askQuestion(claimed.lease, attemptId, testQuestions);
    await api.inbox.resolve({ id: itemId, answer: answered });

    expect(await claimAgain(connected)).toBeUndefined();
  });

  it("gives no message that the agent did not get", async () => {
    const connected = await connect();
    const { api, startAgentStep } = connected;
    const { claimed, stepRunId } = await startAgentStep();
    await api.runs.sendMessage({
      id: claimed.lease.workflowRunId,
      stepRunId,
      text: "Use SQLite",
    });

    expect(await claimAgain(connected)).toBeUndefined();
  });

  it("gives no messages of a finished step run", async () => {
    const connected = await connect();
    const { plane, api, startAgentStep } = connected;
    const { claimed, attemptId, stepRunId } = await startAgentStep();
    const { id: messageId } = await api.runs.sendMessage({
      id: claimed.lease.workflowRunId,
      stepRunId,
      text: "Use SQLite",
    });
    await plane.appendEvents(claimed.lease, {
      batchId: "b1",
      events: [deliveringPrompt(attemptId, messageId)],
    });
    await plane.finishAttempt(claimed.lease, attemptId, { result: { status: "succeeded" } });
    await plane.finishStep(claimed.lease, stepRunId, { status: "succeeded" });

    expect(await claimAgain(connected)).toBeUndefined();
  });

  it("gives no answer of a question whose attempt ended", async () => {
    const { plane, api, waitForQuestion } = await connect();
    const { claimed, stepRunId, itemId } = await waitForQuestion();
    const answer = [{ selected: ["SQLite"], other: null }];
    await api.inbox.resolve({ id: itemId, answer });
    await plane.startAttempt(claimed.lease, stepRunId);

    const { answers } = await plane.sync({
      held: [claimed.lease],
      capacity: 0,
      capabilities: worktreeRunner,
    });

    expect(answers).toEqual([]);
  });

  it("closes the pending questions of a run that its runner gives back", async () => {
    const { db, plane, waitForQuestion } = await connect();
    await waitForQuestion();

    await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });

    expect(await db.select().from(inboxItems)).toMatchObject([
      { decision: null, resolvedBy: "halinka", resolvedAt: expect.any(Date) },
    ]);
  });

  it("keeps the pending gate item of a run that its runner gives back", async () => {
    const { db, plane, waitForGate } = await connect();
    await waitForGate();

    await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });

    expect(await db.select().from(inboxItems)).toMatchObject([{ resolvedAt: null }]);
  });

  it("gives the gate item of an attempt with a question as the item of the step run", async () => {
    const { plane, api, requeue, claimOne, waitForQuestion } = await connect();
    const { claimed, attemptId, itemId } = await waitForQuestion();
    const answer = [{ selected: ["SQLite"], other: null }];
    await api.inbox.resolve({ id: itemId, answer });
    const gateItemId = await plane.askHuman(claimed.lease, attemptId, {
      result: { status: "failed", summary: "Done" },
      kind: "ask_human",
      message: "These gates failed.",
    });
    await requeue(claimed.lease);

    const resumed = await claimOne();

    expect(resumed.steps).toMatchObject([
      { attemptItem: { itemId: gateItemId, kind: "ask_human" } },
    ]);
  });

  it("gives the undelivered messages of a held run in the sync", async () => {
    const { plane, claimed, stepRunId, messageId } = await withMessage();

    const { messages } = await syncHeld(plane, claimed.lease);

    expect(messages).toEqual([
      { workflowRunId: 1, messageId, stepRunId, text: "Use SQLite", author: "local" },
    ]);
  });

  it("gives the undelivered messages of a run at claim", async () => {
    const { plane, requeue, claimed, messageId } = await withMessage();
    await requeue(claimed.lease);

    const { messages } = await plane.sync({
      held: [],
      capacity: 1,
      capabilities: worktreeRunner,
    });

    expect(messages).toMatchObject([{ messageId }]);
  });

  it("gives no message in the sync that a stored prompt delivered", async () => {
    const { plane, claimed, attemptId, messageId } = await withMessage();
    await plane.appendEvents(claimed.lease, {
      batchId: "b1",
      events: [deliveringPrompt(attemptId, messageId)],
    });

    const { messages } = await syncHeld(plane, claimed.lease);

    expect(messages).toEqual([]);
  });

  it("gives no message of a step run that ended", async () => {
    const { plane, claimed, stepRunId } = await withMessage();
    await plane.finishStep(claimed.lease, stepRunId, { status: "succeeded" });

    const { messages } = await syncHeld(plane, claimed.lease);

    expect(messages).toEqual([]);
  });

  it("gives the decision of a gate item that the server resolved at once", async () => {
    const sent = await withMessage();
    const itemId = await askHumanFor(sent);

    const { answers } = await syncHeld(sent.plane, sent.claimed.lease);

    expect(answers).toMatchObject([{ itemId, decision: "retry" }]);
  });

  it("gives the limit item of a stopped attempt as the question", async () => {
    const connected = await connect();
    const itemId = await waitForLimit(connected);

    const resumed = await connected.claimOne();

    expect(resumed.steps).toMatchObject([
      { attemptItem: { itemId, kind: "limit", summary: "Stopped" } },
    ]);
  });

  it("counts no failed attempt for a stopped attempt", async () => {
    const connected = await connect();
    await waitForLimit(connected);

    const resumed = await connected.claimOne();

    expect(resumed.steps).toMatchObject([{ failedAttempts: 0 }]);
  });

  it("gives a running step run no question when an attempt started after its item", async () => {
    const { plane, claimOne, waitForGate } = await connect();
    const { claimed, stepRunId } = await waitForGate();
    await plane.startAttempt(claimed.lease, stepRunId);
    await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });

    const resumed = await claimOne();

    expect(resumed.steps[0]).not.toHaveProperty("question");
  });

  it("gives a finished step run no question", async () => {
    const { plane, requeue, claimOne, waitForGate } = await connect();
    const { claimed, stepRunId } = await waitForGate();
    await plane.finishStep(claimed.lease, stepRunId, { status: "failed" });
    await requeue(claimed.lease);

    const resumed = await claimOne();

    expect(resumed.steps[0]).not.toHaveProperty("question");
  });

  it("makes a claimed run with a pending item wait for input", async () => {
    const { readStatus, requeue, claimOne, waitForGate } = await connect();
    const { claimed } = await waitForGate();
    await requeue(claimed.lease);

    const { lease } = await claimOne();

    expect(await readStatus(lease.workflowRunId)).toBe("waiting_input");
  });

  it("signals a state change of a queued run when the capabilities of the runner change", async () => {
    const { plane, changes } = await syncedQueuedRun();

    await plane.sync({ held: [], capacity: 0, capabilities: devcontainerRunner });

    expect(changes).toEqual(["state"]);
  });

  it("signals no change when the capabilities of the runner stay the same", async () => {
    const { plane, changes } = await syncedQueuedRun();

    await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });

    expect(changes).toEqual([]);
  });

  it("signals no change of a run that is not queued when the capabilities change", async () => {
    const { plane, bus, queue, claimOne } = await connect();
    await queue();
    const { lease } = await claimOne();
    const changes = recordChanges(bus, lease.workflowRunId);

    await plane.sync({ held: [lease], capacity: 0, capabilities: devcontainerRunner });

    expect(changes).toEqual([]);
  });

  it("gives the run branch of a deleted run with the base as the last checkpoint", async () => {
    const context = await finishedRunWithBranch();

    await context.api.runs.delete({ id: 1 });

    expect(await syncedSandboxes(context)).toMatchObject([
      { spec: "destroyed", runBranch: { name: "halinka/run-1", lastCheckpoint: baseSha } },
    ]);
  });

  it("gives the run branch of a deleted run with the last checkpoint of the run", async () => {
    const context = await connect();
    await context.queue();
    const { lease } = await context.claimOne();
    await context.plane.branchCreated(lease);
    const stepRunId = await context.plane.startStep(lease, "build");
    const { attemptId } = await context.plane.startAttempt(lease, stepRunId);
    await context.plane.finishAttempt(lease, attemptId, {
      result: {
        status: "succeeded",
        checkpoint: testCheckpoint(baseSha, "checkpoint-1"),
      },
    });
    await context.plane.finishStep(lease, stepRunId, { status: "succeeded" });
    await context.plane.finishRun(lease, "succeeded");

    await context.api.runs.delete({ id: 1 });

    expect(await syncedSandboxes(context)).toMatchObject([
      { runBranch: { lastCheckpoint: "checkpoint-1" } },
    ]);
  });

  it("gives no run branch with a sandbox that the TTL removes", async () => {
    const context = await finishedRunWithBranch();
    await context.db
      .update(workflowRuns)
      .set({ sandbox: "destroyed", sandboxGeneration: 3 })
      .where(eq(workflowRuns.id, 1));

    const [sandbox] = await syncedSandboxes(context);

    expect(sandbox).not.toHaveProperty("runBranch");
  });

  it("gives no run branch that the run did not create", async () => {
    const context = await connect();
    await context.queue();
    const { lease } = await context.claimOne();
    await context.plane.finishRun(lease, "succeeded");

    await context.api.runs.delete({ id: 1 });

    const [sandbox] = await syncedSandboxes(context);
    expect(sandbox).not.toHaveProperty("runBranch");
  });

  it("gives no run branch that another run has", async () => {
    const context = await finishedRunWithBranch();
    await context.queue();
    await context.db.update(workflowRuns).set({ branchName: "shared" });

    await context.api.runs.delete({ id: 1 });

    const [sandbox] = await syncedSandboxes(context);
    expect(sandbox).not.toHaveProperty("runBranch");
  });

  it("gives the run branch of a deleted run also when the sandbox is already removed", async () => {
    const context = await finishedRunWithBranch();
    await context.db
      .update(workflowRuns)
      .set({ sandbox: "destroyed", sandboxGeneration: 3 })
      .where(eq(workflowRuns.id, 1));
    await context.plane.reportSandbox({ workflowRunId: 1, generation: 3, observed: "absent" });

    await context.api.runs.delete({ id: 1 });

    expect(await syncedSandboxes(context)).toMatchObject([
      { generation: 4, runBranch: { name: "halinka/run-1" } },
    ]);
  });

  it("gives a requested agent test to a process that can take one", async () => {
    const { plane } = await requestedAgentTest(testDb());

    const { agentTest } = await syncRunner(plane, devcontainerRunner);

    expect(agentTest).toEqual({
      token: expect.any(String) as string,
      preset: key.preset,
    });
  });

  it("gives no agent test to a process that restarts for an update", async () => {
    const { api, plane, runnerId } = await createConnectedTestServer(testDb(), withPackage);
    await api.agents.test({ preset: "claude-code", runner: "local" });
    await api.runners.update({ id: runnerId, hasAutoUpdate: true });

    const { agentTest } = await syncRunner(plane, {
      ...devcontainerRunner,
      canUpdate: true,
      build: { version: "0.0.1", id: "other-build" },
    });

    expect(agentTest).toBeUndefined();
  });

  it("gives no agent test to a process that runs one", async () => {
    const { plane } = await requestedAgentTest(testDb());

    const { agentTest } = await syncRunner(plane, devcontainerRunner, { canTest: false });

    expect(agentTest).toBeUndefined();
  });

  it("gives an agent test once", async () => {
    const { plane, token } = await runningAgentTest(testDb());
    await plane.finishAgentTest(token, { capabilities: {} });

    const { agentTest } = await syncRunner(plane, devcontainerRunner);

    expect(agentTest).toBeUndefined();
  });

  it("gives the agent test the version that an Admin selected", async () => {
    const { api, plane } = await requestedAgentTest(testDb());
    await api.agents.update({ preset: key.preset, version: "1.2.3" });

    const { agentTest } = await syncRunner(plane, devcontainerRunner);

    expect(agentTest?.version).toBe("1.2.3");
  });

  it("gives the default model to the agent test", async () => {
    const { api, plane } = await requestedAgentTest(testDb());
    await api.agents.update({ preset: key.preset, model: "small" });

    const { agentTest } = await syncRunner(plane, devcontainerRunner);

    expect(agentTest?.model).toBe("small");
  });

  it("keeps a running agent test when the process cannot take one", async () => {
    const { plane, readTest } = await runningAgentTest(testDb());

    await syncRunner(plane, devcontainerRunner, { canTest: false });

    expect(await readTest()).toMatchObject({ status: "running" });
  });

  it("gives the oldest agent test request first", async () => {
    const { api, plane } = await requestedAgentTest(testDb());
    await api.agents.test({ preset: "codex", runner: "local" });

    const { agentTest } = await syncRunner(plane, devcontainerRunner);

    expect(agentTest?.preset).toBe(key.preset);
  });

  it("fails an agent test whose process ended", async () => {
    const { plane, readTest } = await runningAgentTest(testDb());

    await syncRunner(plane, devcontainerRunner);

    expect(await readTest()).toMatchObject({
      status: "failed",
      error: "The runner stopped during the test",
    });
  });
});

describe("branchCreated", () => {
  it("records that the runner created the run branch", async () => {
    const { db, plane, claimed } = await claimQueuedRun();

    await plane.branchCreated(claimed.lease);

    expect(await db.select().from(workflowRuns)).toMatchObject([{ createdBranch: true }]);
  });
});

describe("startStep", () => {
  it("refuses every call about a run under a lease that is not held", async () => {
    const { plane, claimed } = await claimQueuedRun();
    const stepRunId = await plane.startStep(claimed.lease, "build");
    const lost = { workflowRunId: claimed.lease.workflowRunId, lease: "another-lease" };

    const calls = [
      plane.startStep(lost, "build"),
      plane.finishStep(lost, stepRunId, { status: "failed" }),
      plane.startAttempt(lost, stepRunId),
      plane.finishAttempt(lost, 1, { result: { status: "failed" } }),
      plane.appendEvents(lost, { batchId: "b1", events: [] }),
      plane.openApproval(lost, stepRunId, "Check the diff"),
      plane.branchCreated(lost),
    ];

    await Promise.all(
      calls.map((call) => expect(call).rejects.toMatchObject({ code: "lease_lost" })),
    );
  });

  it("records step runs and their attempts", async () => {
    const { db, plane, claimed } = await claimQueuedRun();
    const { lease } = claimed;

    const stepRunId = await plane.startStep(lease, "build");
    const { attemptId } = await plane.startAttempt(lease, stepRunId);
    await plane.finishAttempt(lease, attemptId, { result: { status: "succeeded", exitCode: 0 } });
    await plane.finishStep(lease, stepRunId, { status: "succeeded" });

    expect(await db.select().from(stepRuns)).toMatchObject([
      { id: stepRunId, stepId: "build", status: "succeeded" },
    ]);
    expect(await db.select().from(stepAttempts)).toMatchObject([
      { stepRunId, attempt: 1, status: "succeeded", exitCode: 0, finishedAt: expect.any(Date) },
    ]);
    await expect(plane.finishStep(lease, stepRunId, { status: "failed" })).rejects.toThrow(
      "not running",
    );
    await expect(
      plane.finishAttempt(lease, attemptId, { result: { status: "failed" } }),
    ).rejects.toThrow("not running");
  });

  it("refuses a child step run of a loop step run that is not running", async () => {
    const { plane, claimed } = await claimQueuedRun();
    const loopStepRunId = await plane.startStep(claimed.lease, "fix_loop");
    await plane.finishStep(claimed.lease, loopStepRunId, { status: "succeeded" });

    const parent = { stepRunId: loopStepRunId, iteration: 1 };
    await expect(plane.startStep(claimed.lease, "build", parent)).rejects.toThrow(
      `Step run ${loopStepRunId} is not running`,
    );
  });

  it("gives the first result to a repeat of a call id", async () => {
    const { plane, claimed } = await claimQueuedRun();
    const call = { ...claimed.lease, callId: "start-1" };
    const stepRunId = await plane.startStep(call, "build");

    const repeated = await plane.startStep(call, "build");

    expect(repeated).toBe(stepRunId);
  });

  it("refuses a repeat of a call id with other arguments", async () => {
    const { plane, claimed } = await claimQueuedRun();
    const call = { ...claimed.lease, callId: "start-1" };
    await plane.startStep(call, "build");

    await expect(plane.startStep(call, "test")).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("refuses a repeat of a call id under another lease", async () => {
    const { plane, claimed } = await claimQueuedRun();
    await plane.startStep({ ...claimed.lease, callId: "start-1" }, "build");

    const repeat = plane.startStep(
      { ...claimed.lease, lease: "other", callId: "start-1" },
      "build",
    );

    await expect(repeat).rejects.toMatchObject({ code: "lease_lost" });
  });

  it("refuses a write of a revoked runner", async () => {
    const { api, plane, claimed } = await claimQueuedRun();
    await api.runners.revoke({ id: 1 });

    await expect(plane.startStep(claimed.lease, "build")).rejects.toMatchObject({
      code: "lease_lost",
    });
  });
});

describe("finishAttempt", () => {
  it("stores the result of the step run and the checkpoint of the attempt", async () => {
    const { db, plane, claimed } = await claimQueuedRun();
    const { lease } = claimed;
    const stepRunId = await plane.startStep(lease, "build");
    const { attemptId } = await plane.startAttempt(lease, stepRunId);
    const checkpoint = { before: baseSha, after: "c1", changedFiles: ["a.ts"] };

    await plane.finishAttempt(lease, attemptId, {
      result: { status: "succeeded", checkpoint },
      stepResult: {
        status: "succeeded",
        summary: "Done",
        outcome: "approved",
        outputs: { files: 2 },
      },
    });

    expect(await db.select().from(stepRuns)).toMatchObject([
      { status: "succeeded", summary: "Done", outcome: "approved", outputs: { files: 2 } },
    ]);
    expect(await db.select().from(stepAttempts)).toMatchObject([
      { commitBefore: baseSha, commitAfter: "c1", changedFiles: ["a.ts"] },
    ]);
  });

  it("finishes the step run with its attempt", async () => {
    const { db, plane, claimed } = await claimQueuedRun();
    const { lease } = claimed;
    const stepRunId = await plane.startStep(lease, "build");
    const { attemptId } = await plane.startAttempt(lease, stepRunId);

    await plane.finishAttempt(lease, attemptId, {
      result: { status: "failed", exitCode: 2 },
      stepResult: { status: "failed" },
    });

    expect(await db.select().from(stepRuns)).toMatchObject([
      { id: stepRunId, stepId: "build", status: "failed" },
    ]);
    expect(await db.select().from(stepAttempts)).toMatchObject([{ status: "failed", exitCode: 2 }]);
  });

  it("keeps the attempt running when its step run is already finished", async () => {
    const { db, plane, claimed } = await claimQueuedRun();
    const stepRunId = await plane.startStep(claimed.lease, "build");
    const { attemptId } = await plane.startAttempt(claimed.lease, stepRunId);
    await db.update(stepRuns).set({ status: "succeeded" }).where(eq(stepRuns.id, stepRunId));

    const checkpoint = { before: baseSha, after: "c1", changedFiles: [] };

    await expect(
      plane.finishAttempt(claimed.lease, attemptId, {
        result: { status: "failed", checkpoint },
        stepResult: { status: "failed" },
      }),
    ).rejects.toThrow("not running");
    expect(
      await db
        .select({ status: stepAttempts.status, commitAfter: stepAttempts.commitAfter })
        .from(stepAttempts),
    ).toEqual([{ status: "running", commitAfter: null }]);
  });

  it("gives the facts of the step run of a finished attempt", async () => {
    const { plane, claimed } = await claimQueuedRun();
    const stepRunId = await plane.startStep(claimed.lease, "implement");
    const first = await plane.startAttempt(claimed.lease, stepRunId);
    await plane.finishAttempt(claimed.lease, first.attemptId, {
      result: {
        status: "failed",
        usage: { activeMs: 1000, costUsd: 0.5 },
        checkpoint: testCheckpoint(baseSha, "c1", ["b.ts", "a.ts"]),
      },
    });
    const second = await plane.startAttempt(claimed.lease, stepRunId);

    const facts = await plane.finishAttempt(claimed.lease, second.attemptId, {
      result: {
        status: "succeeded",
        usage: { activeMs: 2000 },
        checkpoint: testCheckpoint("c1", "c2", ["a.ts"]),
        sessionId: "s-2",
      },
      stepResult: { status: "succeeded" },
    });

    expect(facts).toEqual({
      usage: { activeMs: 3000, costUsd: 0.5 },
      commit: "c2",
      sessionId: "s-2",
      changedFiles: ["a.ts", "b.ts"],
      changedFileCount: 2,
    });
  });

  it("closes the pending question of an attempt that finishes", async () => {
    const { db, plane, waitForQuestion } = await connect();
    const { claimed, attemptId } = await waitForQuestion();

    await plane.finishAttempt(claimed.lease, attemptId, { result: { status: "failed" } });

    expect(await db.select().from(inboxItems)).toMatchObject([{ resolvedBy: "halinka" }]);
  });
});

describe("finishStep", () => {
  it("marks the running attempt lost when its step run finishes without it", async () => {
    const { db, plane, claimed } = await claimQueuedRun();
    const stepRunId = await plane.startStep(claimed.lease, "build");
    await plane.startAttempt(claimed.lease, stepRunId);

    await plane.finishStep(claimed.lease, stepRunId, { status: "cancelled" });

    expect(await db.select().from(stepAttempts)).toMatchObject([
      { status: "lost", finishedAt: expect.any(Date) },
    ]);
  });

  it("gives the facts of a finished step run", async () => {
    const { plane, claimed } = await claimQueuedRun();
    const stepRunId = await plane.startStep(claimed.lease, "implement");
    const { attemptId } = await plane.startAttempt(claimed.lease, stepRunId);
    await plane.finishAttempt(claimed.lease, attemptId, {
      result: {
        status: "failed",
        usage: { activeMs: 1000 },
        checkpoint: testCheckpoint(baseSha, "c1", ["a.ts"]),
      },
    });

    const facts = await plane.finishStep(claimed.lease, stepRunId, { status: "failed" });

    expect(facts).toEqual({
      usage: { activeMs: 1000 },
      commit: "c1",
      changedFiles: ["a.ts"],
      changedFileCount: 1,
    });
  });

  it("stores a skipped step run", async () => {
    const { db, plane, claimed } = await claimQueuedRun();
    const stepRunId = await plane.startStep(claimed.lease, "deploy");

    await plane.finishStep(claimed.lease, stepRunId, { status: "skipped" });

    expect(await db.select().from(stepRuns)).toMatchObject([{ id: stepRunId, status: "skipped" }]);
  });

  it("accepts a step write of a waiting run under its lease", async () => {
    const { db, plane, waitForApproval } = await connect();
    const { claimed, stepRunId } = await waitForApproval();

    await plane.finishStep(claimed.lease, stepRunId, { status: "cancelled" });

    expect(await db.select().from(stepRuns)).toMatchObject([{ status: "cancelled" }]);
  });

  it("closes the pending item when the step run finishes", async () => {
    const { db, plane, waitForApproval } = await connect();
    const { claimed, stepRunId } = await waitForApproval();

    await plane.finishStep(claimed.lease, stepRunId, { status: "failed" });

    expect(await db.select().from(inboxItems)).toMatchObject([
      { decision: null, resolvedBy: "halinka", resolvedAt: expect.any(Date) },
    ]);
  });

  it("stops the wait for input when the step run finishes", async () => {
    const { plane, readStatus, waitForApproval } = await connect();
    const { claimed, stepRunId } = await waitForApproval();

    await plane.finishStep(claimed.lease, stepRunId, { status: "failed" });

    expect(await readStatus(claimed.lease.workflowRunId)).toBe("running");
  });
});

describe("startAttempt", () => {
  it("refuses a step run or an attempt of another run", async () => {
    const { plane, queue, claimOne, claimed } = await claimQueuedRun();
    await queue();
    const other = await claimOne([claimed.lease]);
    const stepRunId = await plane.startStep(claimed.lease, "build");
    const { attemptId } = await plane.startAttempt(claimed.lease, stepRunId);

    await expect(plane.finishStep(other.lease, stepRunId, { status: "failed" })).rejects.toThrow(
      "not running",
    );
    await expect(plane.startAttempt(other.lease, stepRunId)).rejects.toThrow("not running");
    await expect(
      plane.finishAttempt(other.lease, attemptId, { result: { status: "failed" } }),
    ).rejects.toThrow("not running");
  });

  it("numbers a new attempt after the last one", async () => {
    const { plane, claimed } = await claimQueuedRun();
    const stepRunId = await plane.startStep(claimed.lease, "build");

    const first = await plane.startAttempt(claimed.lease, stepRunId);
    const second = await plane.startAttempt(claimed.lease, stepRunId);

    expect(second.attempt).toBe(first.attempt + 1);
  });

  it("marks the running attempt lost at a new attempt", async () => {
    const { db, plane, claimed } = await claimQueuedRun();
    const stepRunId = await plane.startStep(claimed.lease, "build");
    await plane.startAttempt(claimed.lease, stepRunId);

    await plane.startAttempt(claimed.lease, stepRunId);

    expect(
      await db
        .select({ attempt: stepAttempts.attempt, status: stepAttempts.status })
        .from(stepAttempts)
        .orderBy(stepAttempts.attempt),
    ).toEqual([
      { attempt: 1, status: "lost" },
      { attempt: 2, status: "running" },
    ]);
  });

  it("refuses an attempt of a step run that is not running", async () => {
    const { plane, claimed } = await claimQueuedRun();
    const stepRunId = await plane.startStep(claimed.lease, "build");
    await plane.finishStep(claimed.lease, stepRunId, { status: "cancelled" });

    await expect(plane.startAttempt(claimed.lease, stepRunId)).rejects.toThrow("not running");
  });

  it("does not write again for a repeat of a call id", async () => {
    const { db, plane, claimed } = await claimQueuedRun();
    const stepRunId = await plane.startStep(claimed.lease, "build");
    const call = { ...claimed.lease, callId: "attempt-1" };
    await plane.startAttempt(call, stepRunId);

    await plane.startAttempt(call, stepRunId);

    expect(await db.select().from(stepAttempts)).toMatchObject([{ status: "running" }]);
  });

  it("runs a call again when the first one failed", async () => {
    const { plane, claimed } = await claimQueuedRun();
    const call = { ...claimed.lease, callId: "attempt-1" };
    await plane.startAttempt(call, 1).catch(() => {});
    await plane.startStep(claimed.lease, "build");

    await expect(plane.startAttempt(call, 1)).resolves.toEqual({ attemptId: 1, attempt: 1 });
  });

  it("closes the pending questions of a step run when a new attempt starts", async () => {
    const { db, plane, waitForQuestion } = await connect();
    const { claimed, stepRunId } = await waitForQuestion();

    await plane.startAttempt(claimed.lease, stepRunId);

    expect(await db.select().from(inboxItems)).toMatchObject([
      { kind: "question", resolvedBy: "halinka" },
    ]);
  });

  it("sets the run to running when a new attempt closes its question", async () => {
    const { plane, readStatus, waitForQuestion } = await connect();
    const { claimed, stepRunId } = await waitForQuestion();

    await plane.startAttempt(claimed.lease, stepRunId);

    expect(await readStatus(claimed.lease.workflowRunId)).toBe("running");
  });
});

describe("appendEvents", () => {
  it("stores an event batch once when the runner sends it again", async () => {
    const { db, plane, claimed } = await claimQueuedRun();
    const batch = { batchId: "b1", events: [agentPrompt("a"), agentPrompt("b")] };

    await plane.appendEvents(claimed.lease, batch);
    await plane.appendEvents(claimed.lease, batch);
    await plane.appendEvents(claimed.lease, { batchId: "b2", events: [agentPrompt("c")] });

    const events = await db.select().from(workflowRunEvents).orderBy(workflowRunEvents.seq);
    expect(events.map(({ kind, payload }) => ({ kind, payload }))).toEqual([
      agentPrompt("a"),
      agentPrompt("b"),
      agentPrompt("c"),
    ]);
  });

  it("marks no answer delivered when it gets a stored batch again", async () => {
    const { db, plane, api, waitForQuestion } = await connect();
    const { claimed, attemptId, itemId } = await waitForQuestion();
    await api.inbox.resolve({ id: itemId, answer: answered });
    await plane.appendEvents(claimed.lease, { batchId: "b1", events: [agentPrompt("Fix")] });

    await plane.appendEvents(claimed.lease, {
      batchId: "b1",
      events: [answeringPrompt(attemptId, itemId)],
    });

    expect(await db.select().from(inboxItems)).toMatchObject([{ deliveredAt: null }]);
  });

  it("marks no answer of another run delivered", async () => {
    const { db, plane, api, queue } = await connect();
    await queue();
    await queue();
    const { claimed } = await plane.sync({
      held: [],
      capacity: 2,
      capabilities: worktreeRunner,
    });
    const [other, own] = await Promise.all(
      claimed.map(async ({ lease }) => {
        const stepRunId = await plane.startStep(lease, "implement");
        const { attemptId } = await plane.startAttempt(lease, stepRunId);
        const itemId = await plane.askQuestion(lease, attemptId, testQuestions);
        return { lease, attemptId, itemId };
      }),
    );
    if (!other || !own) throw new Error("Two runs were not claimed");
    await api.inbox.resolve({ id: other.itemId, answer: answered });

    await plane.appendEvents(own.lease, {
      batchId: "b1",
      events: [answeringPrompt(own.attemptId, other.itemId)],
    });

    const [item] = await db.select().from(inboxItems).where(eq(inboxItems.id, other.itemId));
    expect(item).toMatchObject({ deliveredAt: null });
  });

  it("marks a message delivered when it stores the prompt that carries it", async () => {
    const { db, plane, claimed, attemptId, messageId } = await withMessage();

    await plane.appendEvents(claimed.lease, {
      batchId: "b1",
      events: [deliveringPrompt(attemptId, messageId)],
    });

    expect(await db.select().from(agentMessages)).toMatchObject([
      { id: messageId, stepAttemptId: attemptId, deliveredAt: expect.any(Date) },
    ]);
  });

  it("keeps the first attempt of a message that a later prompt carries again", async () => {
    const { db, plane, claimed, stepRunId, attemptId, messageId } = await withMessage();
    await plane.appendEvents(claimed.lease, {
      batchId: "b1",
      events: [deliveringPrompt(attemptId, messageId)],
    });
    const { attemptId: nextAttemptId } = await plane.startAttempt(claimed.lease, stepRunId);

    await plane.appendEvents(claimed.lease, {
      batchId: "b2",
      events: [deliveringPrompt(nextAttemptId, messageId)],
    });

    expect(await db.select().from(agentMessages)).toMatchObject([{ stepAttemptId: attemptId }]);
  });

  it("does not mark a message to another step run delivered", async () => {
    const { db, plane, claimed, stepRunId, messageId } = await withMessage();
    await plane.finishStep(claimed.lease, stepRunId, { status: "succeeded" });
    const otherStepRunId = await plane.startStep(claimed.lease, "review");
    const { attemptId } = await plane.startAttempt(claimed.lease, otherStepRunId);

    await plane.appendEvents(claimed.lease, {
      batchId: "b1",
      events: [deliveringPrompt(attemptId, messageId)],
    });

    expect(await db.select().from(agentMessages)).toMatchObject([{ deliveredAt: null }]);
  });

  it("closes the question of the attempt when a prompt delivers a message", async () => {
    const { db, plane, claimed, attemptId, messageId } = await withMessage();
    await plane.askQuestion(claimed.lease, attemptId, testQuestions);

    await plane.appendEvents(claimed.lease, {
      batchId: "b1",
      events: [deliveringPrompt(attemptId, messageId)],
    });

    expect(await db.select().from(inboxItems)).toMatchObject([
      { kind: "question", decision: null, resolvedBy: "halinka" },
    ]);
  });

  it("sets the run to running when a prompt delivers a message", async () => {
    const { plane, readStatus, claimed, attemptId, messageId } = await withMessage();
    await plane.askQuestion(claimed.lease, attemptId, testQuestions);

    await plane.appendEvents(claimed.lease, {
      batchId: "b1",
      events: [deliveringPrompt(attemptId, messageId)],
    });

    expect(await readStatus(claimed.lease.workflowRunId)).toBe("running");
  });

  it("marks no message delivered when it gets a stored batch again", async () => {
    const { db, plane, claimed, attemptId, messageId } = await withMessage();
    await plane.appendEvents(claimed.lease, { batchId: "b1", events: [agentPrompt("Fix")] });

    await plane.appendEvents(claimed.lease, {
      batchId: "b1",
      events: [deliveringPrompt(attemptId, messageId)],
    });

    expect(await db.select().from(agentMessages)).toMatchObject([{ deliveredAt: null }]);
  });

  it("keeps the question open when a prompt has an empty list of messages", async () => {
    const { db, plane, claimed, attemptId } = await withMessage();
    await plane.askQuestion(claimed.lease, attemptId, testQuestions);
    const prompt: RunEvent = {
      kind: "agent_prompt",
      payload: { stepId: "implement", attemptId, text: "Fix", messages: [] },
    };

    await plane.appendEvents(claimed.lease, { batchId: "b1", events: [prompt] });

    expect(await db.select().from(inboxItems)).toMatchObject([{ resolvedAt: null }]);
  });

  it("keeps the question open when a prompt carries no message", async () => {
    const { db, plane, claimed, attemptId } = await withMessage();
    await plane.askQuestion(claimed.lease, attemptId, testQuestions);

    await plane.appendEvents(claimed.lease, { batchId: "b1", events: [agentPrompt("Fix")] });

    expect(await db.select().from(inboxItems)).toMatchObject([{ resolvedAt: null }]);
  });
});

describe("openApproval", () => {
  it("opens an approval item", async () => {
    const { db, waitForApproval } = await connect();

    const { stepRunId, itemId } = await waitForApproval();

    expect(await db.select().from(inboxItems)).toMatchObject([
      { id: itemId, stepRunId, kind: "approval", message: "Check the diff", resolvedAt: null },
    ]);
  });

  it("makes the run wait for input at an approval", async () => {
    const { readStatus, waitForApproval } = await connect();

    const { claimed } = await waitForApproval();

    expect(await readStatus(claimed.lease.workflowRunId)).toBe("waiting_input");
  });

  it("refuses an approval of a step run that is not running", async () => {
    const { db, plane, claimed } = await claimQueuedRun();
    const stepRunId = await plane.startStep(claimed.lease, "approve");
    await plane.finishStep(claimed.lease, stepRunId, { status: "failed" });

    await expect(plane.openApproval(claimed.lease, stepRunId, "Check the diff")).rejects.toThrow(
      "not running",
    );

    expect(await db.select().from(inboxItems)).toEqual([]);
  });

  it("opens the same item again when the run continues the step after a requeue", async () => {
    const { db, plane, readStatus, requeue, claimOne, waitForApproval } = await connect();
    const { claimed, stepRunId, itemId } = await waitForApproval();
    await requeue(claimed.lease);
    const { lease } = await claimOne();

    expect(await plane.openApproval(lease, stepRunId, "Check the diff")).toBe(itemId);

    expect(await db.select().from(inboxItems)).toHaveLength(1);
    expect(await readStatus(lease.workflowRunId)).toBe("waiting_input");
  });

  it("does not make a run wait again for an item that a person decided", async () => {
    const { plane, api, readStatus, requeue, claimOne, waitForApproval } = await connect();
    const { claimed, stepRunId, itemId } = await waitForApproval();
    await requeue(claimed.lease);
    await api.inbox.resolve({ id: itemId, decision: "reject" });
    const { lease } = await claimOne();

    await plane.openApproval(lease, stepRunId, "Check the diff");

    expect(await readStatus(lease.workflowRunId)).toBe("running");
  });
});

describe("askHuman", () => {
  it("finishes the attempt with its report", async () => {
    const { db, waitForGate } = await connect();

    const { attemptId } = await waitForGate();

    expect(await db.select().from(stepAttempts)).toMatchObject([
      { id: attemptId, status: "failed", summary: "Done", outcome: "done" },
    ]);
  });

  it("opens an ask_human item for the attempt", async () => {
    const { db, waitForGate } = await connect();

    const { stepRunId, attemptId, itemId } = await waitForGate();

    expect(await db.select().from(inboxItems)).toMatchObject([
      { id: itemId, stepRunId, stepAttemptId: attemptId, kind: "ask_human", resolvedAt: null },
    ]);
  });

  it("makes the run wait for input at an ask_human item", async () => {
    const { readStatus, waitForGate } = await connect();

    const { claimed } = await waitForGate();

    expect(await readStatus(claimed.lease.workflowRunId)).toBe("waiting_input");
  });

  it("refuses to ask about an attempt that is not running", async () => {
    const { db, plane, claimed } = await claimQueuedRun();
    const stepRunId = await plane.startStep(claimed.lease, "implement");
    const { attemptId } = await plane.startAttempt(claimed.lease, stepRunId);
    await plane.finishAttempt(claimed.lease, attemptId, { result: { status: "failed" } });

    await expect(
      plane.askHuman(claimed.lease, attemptId, {
        result: { status: "failed" },
        kind: "ask_human",
        message: "These gates failed.",
      }),
    ).rejects.toThrow("not running");

    expect(await db.select().from(inboxItems)).toEqual([]);
  });

  it("resolves a gate item at once with retry while the step has an undelivered message", async () => {
    const sent = await withMessage();

    await askHumanFor(sent);

    expect(await sent.db.select().from(inboxItems)).toMatchObject([
      { decision: "retry", note: null, resolvedBy: "halinka", resolvedAt: expect.any(Date) },
    ]);
  });

  it("opens a limit item while the step has an undelivered message", async () => {
    const sent = await withMessage();

    await askHumanFor(sent, "limit");

    expect(await sent.db.select().from(inboxItems)).toMatchObject([
      { kind: "limit", decision: null, resolvedAt: null },
    ]);
  });

  it("keeps the run running when it resolves an item at once", async () => {
    const sent = await withMessage();

    await askHumanFor(sent);

    expect(await sent.readStatus(sent.claimed.lease.workflowRunId)).toBe("running");
  });

  it("keeps an item pending when a prompt delivered the message of the step", async () => {
    const sent = await withMessage();
    const { plane, claimed, stepRunId, attemptId, messageId } = sent;
    await plane.appendEvents(claimed.lease, {
      batchId: "b1",
      events: [deliveringPrompt(attemptId, messageId)],
    });

    await askHumanFor(sent);

    expect(await sent.db.select().from(inboxItems)).toMatchObject([
      { stepRunId, decision: null, resolvedAt: null },
    ]);
  });
});

describe("askQuestion", () => {
  it("keeps the attempt of a question running", async () => {
    const { db, waitForQuestion } = await connect();

    const { attemptId } = await waitForQuestion();

    expect(await db.select().from(stepAttempts)).toMatchObject([
      { id: attemptId, status: "running" },
    ]);
  });

  it("makes the run wait for input when the agent asks a question", async () => {
    const { readStatus, waitForQuestion } = await connect();

    const { claimed } = await waitForQuestion();

    expect(await readStatus(claimed.lease.workflowRunId)).toBe("waiting_input");
  });

  it("opens a question item with the questions and no message", async () => {
    const { db, waitForQuestion } = await connect();

    const { stepRunId, attemptId, itemId } = await waitForQuestion();

    expect(await db.select().from(inboxItems)).toMatchObject([
      {
        id: itemId,
        stepRunId,
        stepAttemptId: attemptId,
        kind: "question",
        message: null,
        questions: testQuestions,
      },
    ]);
  });

  it("opens more than one question for one attempt", async () => {
    const { db, plane, api, waitForQuestion } = await connect();
    const { claimed, attemptId, itemId } = await waitForQuestion();
    const answer = [{ selected: ["SQLite"], other: null }];
    await api.inbox.resolve({ id: itemId, answer });

    await plane.askQuestion(claimed.lease, attemptId, testQuestions);

    expect(await db.select().from(inboxItems)).toHaveLength(2);
  });

  it("refuses a question of an attempt that is not running", async () => {
    const { db, plane, claimed } = await claimQueuedRun();
    const stepRunId = await plane.startStep(claimed.lease, "implement");
    const { attemptId } = await plane.startAttempt(claimed.lease, stepRunId);
    await plane.finishAttempt(claimed.lease, attemptId, { result: { status: "failed" } });

    await expect(plane.askQuestion(claimed.lease, attemptId, testQuestions)).rejects.toThrow(
      "not running",
    );

    expect(await db.select().from(inboxItems)).toEqual([]);
  });
});

const buildPath = ".halinka/workflows/build.yml";

const reviewedWorkflow = [
  "schema_version: 1",
  "name: Reviewed",
  "steps:",
  "  - id: review",
  "    type: agent",
  "    agent: claude-code",
  "    prompt: Review",
  "    permissions: { write: false }",
  "  - { id: approve, type: approval, message: Ship it, reviewers: [review] }",
  ...publishSteps,
  "",
].join("\n");

const claimGitHubRun = async (gitHub: FakeGitHub, workflow?: string) => {
  const server = await createConnectedTestServer(testDb());
  await connectApp(server.api, gitHub, [installationOf(10, [repoOf(100, "app")])]);
  if (workflow) server.files[buildPath] = workflow;
  await server.api.runs.create({ repoId: 1, workflow: "build" });
  await makeGitHubRepo(testDb(), 1, 100);
  gitHub.requests.length = 0;
  return { ...server, claimed: await server.claimOne() };
};

describe("readMirrorAccess", () => {
  const gitHub = new FakeGitHub();

  it("names the GitHub repo in the claim, with no path", async () => {
    const { claimed } = await claimGitHubRun(gitHub);

    expect(claimed).toMatchObject({ githubRepoId: 100 });
    expect(claimed).not.toHaveProperty("repoPath");
  });

  it("gives a read token of the repo of the run", async () => {
    const { plane, claimed } = await claimGitHubRun(gitHub);

    expect(await plane.readMirrorAccess(claimed.lease)).toEqual({
      owner: "acme",
      name: "app",
      token: "token-10",
    });
    expect(gitHub.readsOf("/app/installations/10/access_tokens").map(({ body }) => body)).toEqual([
      { repository_ids: [100], permissions: { contents: "read" } },
    ]);
  });

  it("refuses a lease that the process does not hold", async () => {
    const { plane, claimed } = await claimGitHubRun(gitHub);

    await expect(
      plane.readMirrorAccess({ ...claimed.lease, lease: "other" }),
    ).rejects.toMatchObject({ code: "lease_lost" });
  });

  it("asks GitHub nothing for a lease that the process does not hold", async () => {
    const { plane, claimed } = await claimGitHubRun(gitHub);

    await plane.readMirrorAccess({ ...claimed.lease, lease: "other" }).catch(() => {});

    expect(gitHub.requests).toEqual([]);
  });

  it("refuses a run of a local repo", async () => {
    const { plane, claimed } = await claimQueuedRun();

    await expect(plane.readMirrorAccess(claimed.lease)).rejects.toMatchObject({ code: "conflict" });
  });

  it("gives the reason as a conflict when no App is connected", async () => {
    const { api, plane, claimed } = await claimGitHubRun(gitHub);
    await api.github.disconnect();

    await expect(plane.readMirrorAccess(claimed.lease)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("needs the App"),
    });
  });
});

const firstCommit = "a".repeat(40);
const secondCommit = "b".repeat(40);

const withCheckpoint = async <T extends { plane: ControlPlane }>(server: T, lease: RunLease) => {
  const build = await server.plane.startStep(lease, "build");
  const { attemptId } = await server.plane.startAttempt(lease, build);
  await server.plane.finishAttempt(lease, attemptId, {
    result: { status: "succeeded", checkpoint: testCheckpoint(baseSha, firstCommit) },
    stepResult: { status: "succeeded" },
  });
  return { ...server, lease, stepRunId: await server.plane.startStep(lease, "publish") };
};

const claimLocalPublish = async () => {
  const server = await connect();
  server.files[buildPath] = publishWorkflow;
  await server.queue();
  return withCheckpoint(server, (await server.claimOne()).lease);
};

const commentWorkflow = [
  "schema_version: 1",
  "name: Comment",
  "on:",
  "  pull_request:",
  "    types: [opened]",
  "steps:",
  "  - { id: build, type: shell, run: ls }",
  "  - { id: publish, type: github, action: comment_on_pull_request, body: Done }",
  "",
].join("\n");

describe("readPushAccess", () => {
  const gitHub = new FakeGitHub();

  const startedGitHubRun = async () => {
    const server = await claimGitHubRun(gitHub, publishWorkflow);
    return withCheckpoint(server, server.claimed.lease);
  };

  const commentingRun = async () => {
    const server = await claimGitHubRun(gitHub, commentWorkflow);
    const started = await withCheckpoint(server, server.claimed.lease);
    gitHub.requests.length = 0;
    return started;
  };

  const startedStep = async (stepId: string) => {
    const server = await claimGitHubRun(gitHub, publishWorkflow);
    const { lease } = server.claimed;
    const stepRunId = await server.plane.startStep(lease, stepId);
    return { readPushAccess: () => server.plane.readPushAccess(lease, stepRunId) };
  };

  const refusals: [string, () => Promise<{ readPushAccess: () => Promise<unknown> }>, object][] = [
    [
      "a lease that the process does not hold",
      async () => {
        const { plane, lease, stepRunId } = await startedGitHubRun();
        return {
          readPushAccess: () => plane.readPushAccess({ ...lease, lease: "other" }, stepRunId),
        };
      },
      { code: "lease_lost" },
    ],
    [
      "a step run that does not run",
      async () => {
        const { plane, lease, stepRunId } = await startedGitHubRun();
        await plane.finishStep(lease, stepRunId, { status: "succeeded" });
        return { readPushAccess: () => plane.readPushAccess(lease, stepRunId) };
      },
      { code: "conflict" },
    ],
    [
      "a run that changed nothing",
      () => startedStep("publish"),
      { code: "conflict", message: "Run 1 changed nothing to push" },
    ],
    [
      "a step of another kind",
      () => startedStep("build"),
      { code: "conflict", message: "The step build does not open a pull request" },
    ],
    [
      "a step that comments",
      async () => {
        const { plane, lease, stepRunId } = await commentingRun();
        return { readPushAccess: () => plane.readPushAccess(lease, stepRunId) };
      },
      { code: "conflict", message: "The step publish does not open a pull request" },
    ],
  ];

  it("gives the last checkpoint and a token of the repo of the run", async () => {
    const { plane, lease, stepRunId } = await startedGitHubRun();

    expect(await plane.readPushAccess(lease, stepRunId)).toEqual({
      commit: firstCommit,
      github: { owner: "acme", name: "app", token: "token-10" },
    });
  });

  it("asks GitHub for the permissions of a pull request", async () => {
    const { plane, lease, stepRunId } = await startedGitHubRun();

    await plane.readPushAccess(lease, stepRunId);

    expect(gitHub.readsOf("/app/installations/10/access_tokens").map(({ body }) => body)).toEqual([
      {
        repository_ids: [100],
        permissions: { contents: "write", pull_requests: "write", metadata: "read" },
      },
    ]);
  });

  it("gives the stored lease of the branch", async () => {
    const { plane, lease, stepRunId } = await startedGitHubRun();
    await plane.storePushedBranch(lease, stepRunId, {});

    expect(await plane.readPushAccess(lease, stepRunId)).toMatchObject({
      pushedCommit: firstCommit,
    });
  });

  it("gives a token to a github step in a loop", async () => {
    const loopWorkflow = [
      "schema_version: 1",
      "name: Loop",
      "steps:",
      "  - { id: build, type: shell, run: ls }",
      "  - id: again",
      "    type: loop",
      "    max_iterations: 2",
      "    until: ${{ steps.publish.status == 'succeeded' }}",
      "    steps:",
      "      - { id: publish, type: github, action: open_pull_request }",
      "",
    ].join("\n");
    const server = await claimGitHubRun(gitHub, loopWorkflow);
    const { lease } = server.claimed;
    const build = await server.plane.startStep(lease, "build");
    const { attemptId } = await server.plane.startAttempt(lease, build);
    await server.plane.finishAttempt(lease, attemptId, {
      result: { status: "succeeded", checkpoint: testCheckpoint(baseSha, firstCommit) },
      stepResult: { status: "succeeded" },
    });
    const loop = await server.plane.startStep(lease, "again");
    const stepRunId = await server.plane.startStep(lease, "publish", {
      stepRunId: loop,
      iteration: 1,
    });

    expect(await server.plane.readPushAccess(lease, stepRunId)).toMatchObject({
      commit: firstCommit,
    });
  });

  it.each(refusals)("refuses %s", async (_, refusal, error) => {
    const { readPushAccess } = await refusal();

    await expect(readPushAccess()).rejects.toMatchObject(error);
  });

  it.each(refusals)("asks GitHub nothing for %s", async (_, refusal) => {
    const { readPushAccess } = await refusal();

    await readPushAccess().catch(() => {});

    expect(gitHub.requests).toEqual([]);
  });

  it("refuses to store a pushed branch of a step that comments", async () => {
    const { plane, lease, stepRunId } = await commentingRun();

    await expect(plane.storePushedBranch(lease, stepRunId, {})).rejects.toThrow(
      "does not open a pull request",
    );
  });

  it("refuses a checkpoint after the review of the last approval", async () => {
    const server = await connect();
    server.files[buildPath] = reviewedWorkflow;
    await server.queue();
    const { lease } = await server.claimOne();
    const review = await server.plane.startStep(lease, "review");
    const { attemptId } = await server.plane.startAttempt(lease, review);
    await server.plane.finishAttempt(lease, attemptId, {
      result: { status: "succeeded", checkpoint: testCheckpoint(baseSha, secondCommit) },
      stepResult: { status: "succeeded" },
    });
    const approve = await server.plane.startStep(lease, "approve");
    await server.plane.finishStep(lease, approve, { status: "succeeded" });
    const { stepRunId } = await withCheckpoint(server, lease);

    await expect(server.plane.readPushAccess(lease, stepRunId)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("The step `review` reviewed"),
    });
  });

  it("refuses a GitHub repo with no App", async () => {
    const { api, plane, lease, stepRunId } = await startedGitHubRun();
    await api.github.disconnect();

    await expect(plane.readPushAccess(lease, stepRunId)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("needs the App"),
    });
  });

  it("gives a token to a local repo with a link", async () => {
    const server = await createConnectedTestServer(testDb());
    await connectApp(server.api, gitHub, [installationOf(10, [repoOf(100, "app")])]);
    await server.api.repos.linkGitHub({ id: 1, githubRepoId: 100 });
    server.files[buildPath] = publishWorkflow;
    await server.queue();
    const { plane, lease, stepRunId } = await withCheckpoint(
      server,
      (await server.claimOne()).lease,
    );

    expect(await plane.readPushAccess(lease, stepRunId)).toMatchObject({
      github: { owner: "acme", name: "app" },
    });
  });

  it("gives no token to a local repo with no link", async () => {
    const { plane, lease, stepRunId } = await claimLocalPublish();

    expect(await plane.readPushAccess(lease, stepRunId)).toEqual({
      commit: firstCommit,
      github: undefined,
    });
  });
});

describe("storePushedBranch", () => {
  const url = "https://github.com/acme/app/pull/1";

  it("stores the last checkpoint and the URL for the run page", async () => {
    const { api, plane, lease, stepRunId } = await claimLocalPublish();

    await plane.storePushedBranch(lease, stepRunId, { pullRequestUrl: url });

    expect(await api.runs.get({ id: lease.workflowRunId })).toMatchObject({
      pushedCommit: firstCommit,
      pullRequestUrl: url,
    });
  });

  it("keeps the URL when a later write has none", async () => {
    const { api, plane, lease, stepRunId } = await claimLocalPublish();
    await plane.storePushedBranch(lease, stepRunId, { pullRequestUrl: url });

    await plane.storePushedBranch(lease, stepRunId, { expected: firstCommit });

    expect(await api.runs.get({ id: lease.workflowRunId })).toMatchObject({ pullRequestUrl: url });
  });

  it("refuses a write when the stored commit is another", async () => {
    const { plane, lease, stepRunId } = await claimLocalPublish();
    await plane.storePushedBranch(lease, stepRunId, {});

    await expect(
      plane.storePushedBranch(lease, stepRunId, { expected: secondCommit }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses a step run that does not run", async () => {
    const { plane, lease, stepRunId } = await claimLocalPublish();
    await plane.finishStep(lease, stepRunId, { status: "succeeded" });

    await expect(plane.storePushedBranch(lease, stepRunId, {})).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("gives the first result to a repeat of a call", async () => {
    const { api, plane, lease, stepRunId } = await claimLocalPublish();
    const call = { ...lease, callId: "call-1" };
    const write = {};
    await plane.storePushedBranch(call, stepRunId, write);

    await plane.storePushedBranch(call, stepRunId, write);

    expect(await api.runs.get({ id: call.workflowRunId })).toMatchObject({
      pushedCommit: firstCommit,
    });
  });

  it("refuses a lease that the process does not hold", async () => {
    const { plane, lease, stepRunId } = await claimLocalPublish();

    await expect(
      plane.storePushedBranch({ ...lease, lease: "other" }, stepRunId, {}),
    ).rejects.toMatchObject({ code: "lease_lost" });
  });
});

describe("readSetupSecrets", () => {
  const value = "npm_made_up_value";
  const config = `${devcontainerConfig}setup:\n  run: npm ci\n  secrets: [NPM_TOKEN]\n`;

  const claimSetUpRun = async () => {
    const server = await createConnectedTestServer(testDb());
    server.files[".halinka/config.yml"] = config;
    await server.api.repos.setSecret({ id: 1, name: "NPM_TOKEN", value });
    await server.api.repos.setSecret({ id: 1, name: "OTHER_TOKEN", value: "other_made_up_value" });
    await server.api.runs.create({ repoId: 1, workflow: "build" });
    return { ...server, claimed: await server.claimOne([], "devcontainer") };
  };

  it("gives only the secrets that the config names", async () => {
    const { plane, claimed } = await claimSetUpRun();

    expect(await plane.readSetupSecrets(claimed.lease)).toEqual({
      values: [{ variable: "NPM_TOKEN", value }],
      missing: [],
    });
  });

  it("refuses a lease that the process does not hold", async () => {
    const { plane, claimed } = await claimSetUpRun();

    await expect(
      plane.readSetupSecrets({ ...claimed.lease, lease: "other" }),
    ).rejects.toMatchObject({ code: "lease_lost" });
  });

  it("refuses the lease of a run of another runner", async () => {
    const { claimed } = await claimSetUpRun();
    const other = await otherRunnerPlane(testDb());

    await expect(other.readSetupSecrets(claimed.lease)).rejects.toMatchObject({
      code: "lease_lost",
    });
  });

  it("refuses a run in a worktree", async () => {
    const { plane, claimed } = await claimQueuedRun();

    await expect(plane.readSetupSecrets(claimed.lease)).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("names a secret that an Admin removed after the start", async () => {
    const { api, plane, claimed } = await claimSetUpRun();
    await api.repos.deleteSecret({ id: 1, name: "NPM_TOKEN" });

    expect(await plane.readSetupSecrets(claimed.lease)).toEqual({
      values: [],
      missing: ["NPM_TOKEN"],
    });
  });

  it("names a secret with a value of another master key", async () => {
    const { plane, claimed } = await claimSetUpRun();
    await createRepositories(testDb()).repoSecret.save({
      repoId: 1,
      name: "NPM_TOKEN",
      sealed: new SecretCipher(randomBytes(32)).seal(repoSecretPlace(1, "NPM_TOKEN"), value),
    });

    expect(await plane.readSetupSecrets(claimed.lease)).toEqual({
      values: [],
      missing: ["NPM_TOKEN"],
    });
  });
});

describe("readAgentCredentials", () => {
  const claimAgentRun = async () => {
    const server = await createConnectedTestServer(testDb());
    server.files[".halinka/workflows/implement.yml"] = implementWorkflow;
    server.files[".halinka/config.yml"] = devcontainerConfig;
    await server.api.agents.setCredential({ ...key, value: stored.value });
    await server.api.runs.create({ repoId: 1, workflow: "implement" });
    return { ...server, claimed: await server.claimOne([], "devcontainer") };
  };

  it("gives the stored values of the agent to the holder of the lease", async () => {
    const { plane, claimed } = await claimAgentRun();

    expect(await plane.readAgentCredentials(claimed.lease, key.preset)).toEqual([stored]);
  });

  it("gives nothing when no value is stored", async () => {
    const { api, plane, claimed } = await claimAgentRun();
    await api.agents.deleteCredential(key);

    expect(await plane.readAgentCredentials(claimed.lease, key.preset)).toEqual([]);
  });

  it("gives a changed value at the next read", async () => {
    const { api, plane, claimed } = await claimAgentRun();
    await api.agents.setCredential({ ...key, value: "sk-ant-second-value" });

    expect(await plane.readAgentCredentials(claimed.lease, key.preset)).toEqual([
      { variable: key.variable, value: "sk-ant-second-value" },
    ]);
  });

  it("refuses a lease that the process does not hold", async () => {
    const { plane, claimed } = await claimAgentRun();

    await expect(
      plane.readAgentCredentials({ ...claimed.lease, lease: "other" }, key.preset),
    ).rejects.toMatchObject({ code: "lease_lost" });
  });

  it("refuses the lease of a run of another runner", async () => {
    const { claimed } = await claimAgentRun();
    const other = await otherRunnerPlane(testDb());

    await expect(other.readAgentCredentials(claimed.lease, key.preset)).rejects.toMatchObject({
      code: "lease_lost",
    });
  });

  it("refuses an agent that the workflow does not use", async () => {
    const { plane, claimed } = await claimAgentRun();

    await expect(plane.readAgentCredentials(claimed.lease, "codex")).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("refuses an agent that the runner does not allow any more", async () => {
    const { api, runnerId, plane, claimed } = await claimAgentRun();
    await api.runners.update({ id: runnerId, labels: [], allowedAgents: ["codex"] });

    await expect(plane.readAgentCredentials(claimed.lease, key.preset)).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("refuses a run in a worktree, which has no proxy", async () => {
    const server = await createConnectedTestServer(testDb());
    await server.api.agents.setCredential({ ...key, value: stored.value });
    const { claimed } = await server.startAgentStep();

    await expect(
      server.plane.readAgentCredentials(claimed.lease, key.preset),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("names the place to enter a value of another master key again", async () => {
    const { plane, claimed } = await claimAgentRun();
    const place = { ...key, memberId: null };
    await createRepositories(testDb()).agentCredential.save({
      ...place,
      sealed: new SecretCipher(randomBytes(32)).seal(credentialPlace(place), stored.value),
    });

    await expect(plane.readAgentCredentials(claimed.lease, key.preset)).rejects.toThrow(
      "Enter the value again on the Agents page",
    );
  });
});

describe("readTestCredentials", () => {
  it("gives the stored values to the runner of a running test", async () => {
    const { api, plane, token } = await runningAgentTest(testDb());
    await api.agents.setCredential({ ...key, value: stored.value });

    expect(await plane.readTestCredentials(token)).toEqual([stored]);
  });

  it("refuses the values of a token that it does not know", async () => {
    const { plane } = await runningAgentTest(testDb());

    await expect(plane.readTestCredentials("other")).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses the values of a finished test", async () => {
    const { plane, token } = await runningAgentTest(testDb());
    await plane.finishAgentTest(token, { capabilities: {} });

    await expect(plane.readTestCredentials(token)).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses the values of a test of another runner", async () => {
    const { token } = await runningAgentTest(testDb());
    const other = await otherRunnerPlane(testDb());

    await expect(other.readTestCredentials(token)).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses the values to a worktree runner, which has no proxy", async () => {
    const { plane, token } = await runningAgentTest(testDb(), worktreeRunner);

    await expect(plane.readTestCredentials(token)).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses the values of an agent that the runner does not allow any more", async () => {
    const { api, runnerId, plane, token } = await runningAgentTest(testDb());
    await api.runners.update({ id: runnerId, labels: [], allowedAgents: ["codex"] });

    await expect(plane.readTestCredentials(token)).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses the values to a revoked runner", async () => {
    const { api, runnerId, plane, token } = await runningAgentTest(testDb());
    await api.runners.revoke({ id: runnerId });

    await expect(plane.readTestCredentials(token)).rejects.toMatchObject({ code: "refused" });
  });
});

describe("finishAgentTest", () => {
  it("stores the capabilities of a test that passed", async () => {
    const { plane, token, readTest } = await runningAgentTest(testDb());

    await plane.finishAgentTest(token, { capabilities: { loadSession: true } });

    expect(await readTest()).toMatchObject({
      status: "passed",
      capabilities: { loadSession: true },
    });
  });

  it("stores the error of a test that failed", async () => {
    const { plane, token, readTest } = await runningAgentTest(testDb());

    await plane.finishAgentTest(token, { error: "Invalid API key" });

    expect(await readTest()).toMatchObject({ status: "failed", error: "Invalid API key" });
  });

  it("ignores the result of a test that a later request replaced", async () => {
    const { api, plane, token, readTest } = await runningAgentTest(testDb());
    await api.agents.test({ preset: key.preset, runner: "local" });

    await plane.finishAgentTest(token, { capabilities: {} });

    expect(await readTest()).toMatchObject({ status: "requested" });
  });

  it("ignores the result from another runner", async () => {
    const { token, readTest } = await runningAgentTest(testDb());
    const other = await otherRunnerPlane(testDb());

    await other.finishAgentTest(token, { capabilities: {} });

    expect(await readTest()).toMatchObject({ status: "running" });
  });

  it("keeps a limited length of an error", async () => {
    const { plane, token, readTest } = await runningAgentTest(testDb());

    await plane.finishAgentTest(token, { error: "x".repeat(maxRunErrorLength + 1) });

    expect((await readTest())?.error).toHaveLength(maxRunErrorLength);
  });

  it("refuses the result from a revoked runner", async () => {
    const { api, runnerId, plane, token } = await runningAgentTest(testDb());
    await api.runners.revoke({ id: runnerId });

    await expect(plane.finishAgentTest(token, { capabilities: {} })).rejects.toMatchObject({
      code: "refused",
    });
  });
});
