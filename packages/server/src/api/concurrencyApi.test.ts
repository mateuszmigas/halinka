import type { RunLease } from "@halinka/protocol";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { inboxItems } from "../db/schema";
import { defaultLeaseTimes } from "../leaseTimes";
import { RunBus } from "../runBus";
import { sweep } from "../sweep";
import { createConnectedTestServer, secondRepoPath, setUpTestDb, worktreeRunner } from "../testing";

const testDb = setUpTestDb();

const deployPath = ".halinka/workflows/deploy.yml";

const workflowOf = (group: string, ...fields: string[]) =>
  [
    "schema_version: 1",
    "name: Deploy",
    "inputs:",
    "  env: { type: string, default: prod }",
    "concurrency:",
    `  group: ${group}`,
    ...fields,
    "steps:",
    "  - { id: build, type: shell, run: ls }",
  ].join("\n");

const agentWorkflow = [
  "schema_version: 1",
  "name: Agent",
  "concurrency: { group: deploy }",
  "steps:",
  "  - { id: fix, type: agent, agent: claude-code, prompt: Fix }",
].join("\n");

const noAgents = { ...worktreeRunner, agentsOnPath: [] };

const setUp = async (source = workflowOf("deploy")) => {
  const server = await createConnectedTestServer(testDb());
  const { api, files, plane } = server;
  files[deployPath] = source;
  const start = (inputs?: Record<string, string>, repoId = 1) =>
    api.runs.create({ repoId, workflow: "deploy", inputs });
  const claimAll = async (held: RunLease[] = [], capabilities = worktreeRunner) =>
    (await plane.sync({ held, capacity: 5, capabilities })).claimed;
  const expireFirstRun = async () => {
    const [first] = await claimAll();
    const { lease } = first!;
    const stepRunId = await plane.startStep(lease, "build");
    await plane.startAttempt(lease, stepRunId);
    const itemId = await plane.openApproval(lease, stepRunId, "Check");
    await testDb()
      .update(inboxItems)
      .set({ createdAt: sql`now() - make_interval(hours => 25)` });
    await sweep(testDb(), new RunBus(), defaultLeaseTimes.leaseSeconds);
    return itemId;
  };
  return { ...server, start, claimAll, expireFirstRun };
};

const claimedIds = (claimed: { lease: { workflowRunId: number } }[]) =>
  claimed.map(({ lease }) => lease.workflowRunId);

const cancellingWorkflow = workflowOf("deploy", "  cancel_in_progress: true");

describe("sync", () => {
  it("claims one run of a concurrency group", async () => {
    const { start, claimAll } = await setUp();
    await start();
    await start();

    expect(claimedIds(await claimAll())).toEqual([1]);
  });

  it("claims the next run when the first ends", async () => {
    const { plane, start, claimAll } = await setUp();
    await start();
    await start();
    const [first] = await claimAll();
    await plane.finishRun(first!.lease, "succeeded");

    expect(claimedIds(await claimAll())).toEqual([2]);
  });

  it("keeps the group slot of a run that waits for a person", async () => {
    const { plane, start, claimAll } = await setUp();
    await start();
    await start();
    const [first] = await claimAll();
    const { lease } = first!;
    const stepRunId = await plane.startStep(lease, "build");
    await plane.startAttempt(lease, stepRunId);
    await plane.openApproval(lease, stepRunId, "Check");

    expect(await claimAll([lease])).toEqual([]);
  });

  it("frees the group slot of an expired run", async () => {
    const { start, claimAll, expireFirstRun } = await setUp();
    await start();
    await start();
    await expireFirstRun();

    expect(claimedIds(await claimAll())).toEqual([2]);
  });

  it("holds the group behind a lower run that no runner can take", async () => {
    const { api, files, start, claimAll } = await setUp();
    files[".halinka/workflows/agent.yml"] = agentWorkflow;
    await api.runs.create({ repoId: 1, workflow: "agent" });
    await start();

    expect(await claimAll([], noAgents)).toEqual([]);
  });

  it("claims the runs of two groups at one time", async () => {
    const { start, claimAll } = await setUp(workflowOf("deploy-${{ inputs.env }}"));
    await start({ env: "prod" });
    await start({ env: "test" });

    expect(claimedIds(await claimAll())).toEqual([1, 2]);
  });

  it("claims the runs of one group name in two repos at one time", async () => {
    const { api, runnerId, start, claimAll } = await setUp();
    await api.repos.register({ runnerId, path: secondRepoPath });
    await start();
    await start(undefined, 2);

    expect(claimedIds(await claimAll())).toEqual([1, 2]);
  });

  it("holds the new run of cancel_in_progress while the running run stops", async () => {
    const { start, claimAll } = await setUp(cancellingWorkflow);
    await start();
    const [first] = await claimAll();
    await start();

    expect(await claimAll([first!.lease])).toEqual([]);
  });
});

describe("GET /api/runs/{id}", () => {
  it("gives a run behind a running run of its group the wait reason with that run", async () => {
    const { api, start, claimAll } = await setUp();
    await start();
    await start();
    await claimAll();

    const { waitReason } = await api.runs.get({ id: 2 });

    expect(waitReason).toBe("The run 1 of the concurrency group deploy goes first");
  });

  it("gives a run behind a lower queued run of its group the wait reason with that run", async () => {
    const { api, start } = await setUp();
    await start();
    await start();

    const { waitReason } = await api.runs.get({ id: 2 });

    expect(waitReason).toBe("The run 1 of the concurrency group deploy goes first");
  });

  it("gives a queued run that goes first in its group no wait reason", async () => {
    const { api, start } = await setUp();
    await start();
    await start();

    expect((await api.runs.get({ id: 1 })).waitReason).toBeUndefined();
  });

  it("gives the wait reason of the runner before the reason of the group", async () => {
    const { api, files, plane, start, claimAll } = await setUp();
    await start();
    await claimAll();
    files[".halinka/workflows/agent.yml"] = agentWorkflow;
    await api.runs.create({ repoId: 1, workflow: "agent" });
    await plane.sync({ held: [], capacity: 0, capabilities: noAgents });

    const { waitReason } = await api.runs.get({ id: 2 });

    expect(waitReason).not.toContain("concurrency group");
  });
});

describe("POST /api/inbox/{id}/resolve", () => {
  it("makes a continued expired run wait for the run that took its group slot", async () => {
    const { api, start, claimAll, expireFirstRun } = await setUp();
    await start();
    await start();
    const itemId = await expireFirstRun();
    await claimAll();

    await api.inbox.resolve({ id: itemId, decision: "approve" });

    const { status, waitReason } = await api.runs.get({ id: 1 });
    expect({ status, waitReason }).toEqual({
      status: "queued",
      waitReason: "The run 2 of the concurrency group deploy goes first",
    });
  });
});

describe("POST /api/runs", () => {
  it("refuses a run whose group is empty", async () => {
    const { start } = await setUp(workflowOf('"${{ inputs.env }}"'));

    await expect(start({ env: " " })).rejects.toThrow("The concurrency group is empty");
  });

  it("cancels a queued run of the group at cancel_in_progress", async () => {
    const { api, start } = await setUp(cancellingWorkflow);
    await start();

    await start();

    expect((await api.runs.get({ id: 1 })).status).toBe("cancelled");
  });

  it("asks a running run of the group to cancel at cancel_in_progress", async () => {
    const { api, start, claimAll } = await setUp(cancellingWorkflow);
    await start();
    await claimAll();

    await start();

    const { status, cancelRequestedAt } = await api.runs.get({ id: 1 });
    expect({ status, requested: cancelRequestedAt !== null }).toEqual({
      status: "running",
      requested: true,
    });
  });

  it("cancels an expired run of the group at cancel_in_progress", async () => {
    const { api, start, expireFirstRun } = await setUp(cancellingWorkflow);
    await start();
    await expireFirstRun();

    await start();

    expect((await api.runs.get({ id: 1 })).status).toBe("cancelled");
  });

  it("leaves the new run queued at cancel_in_progress", async () => {
    const { api, start } = await setUp(cancellingWorkflow);
    await start();

    const { id } = await start();

    expect((await api.runs.get({ id })).status).toBe("queued");
  });

  it("leaves a run of another group at cancel_in_progress", async () => {
    const { api, start } = await setUp(
      workflowOf("deploy-${{ inputs.env }}", "  cancel_in_progress: true"),
    );
    await start({ env: "prod" });

    await start({ env: "test" });

    expect((await api.runs.get({ id: 1 })).status).toBe("queued");
  });

  it("keeps the older run at cancel_in_progress when the new run is refused", async () => {
    const { api, start, files } = await setUp(cancellingWorkflow);
    await start();
    files[deployPath] = workflowOf("deploy", "  cancel_in_progress: true", "runs-on: [gpu]");

    await expect(start()).rejects.toThrow("gpu");

    expect((await api.runs.get({ id: 1 })).status).toBe("queued");
  });
});

describe("POST /api/runs/tests", () => {
  it("gives a test run no concurrency group", async () => {
    const { api, start, claimAll } = await setUp();
    await start();
    await claimAll();
    const { hash } = await api.repos.workflow({ id: 1, workflow: "deploy" });

    const { id } = await api.runs.test({
      repoId: 1,
      workflow: "deploy",
      source: `${workflowOf("deploy")}\n`,
      baseHash: hash,
    });

    const { waitReason } = await api.runs.get({ id });
    expect(waitReason ?? "").not.toContain("concurrency group");
  });
});
