import { protocolVersion } from "@halinka/protocol";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { defaultLeaseTimes } from "../../leaseTimes";
import { devcontainerRunner, registerTestRunner, setUpTestDb, testKeyOf } from "../../testing";
import { workflowRuns } from "../schema";
import { createRepositories, inTransaction } from "./createRepositories";

const path = ".halinka/workflows/build.yml";
const workflow = {
  path,
  files: { [path]: "schema_version: 1\nname: Build\n" },
  resolved: { name: "Build", steps: [{ id: "build", type: "shell" as const, run: "ls" }] },
  runsOn: [],
  agents: [],
};

const testDb = setUpTestDb();

const setUp = async () => {
  const db = testDb();
  const { repo: repos, workflowSnapshot, workflowRun: runs } = createRepositories(db);
  const { id: runnerId } = await registerTestRunner(db, "local");
  const repo = await repos.register({ name: "app", path: "/code/app", runnerId });
  const queueIn = async (
    repoId: number,
    onRunner: number | null = runnerId,
    {
      devcontainer,
      isUntrusted,
      isTestRun,
    }: { devcontainer?: string; isUntrusted?: boolean; isTestRun?: boolean } = {},
  ) => {
    const snapshot = await workflowSnapshot.findOrCreate({ repoId, ...workflow, devcontainer });
    const run = await runs.create({
      repoId,
      runnerId: onRunner,
      workflowSnapshotId: snapshot.id,
      inputs: {},
      isUntrusted,
      isTestRun,
      baseSha: "abc",
      definitionSha: "abc",
    });
    if (!run) throw new Error("No run was queued");
    return run;
  };
  const queue = () => queueIn(repo.id);
  const queueOnOtherRunner = async () => {
    const other = await registerTestRunner(db, "other");
    const otherRepo = await repos.register({ name: "web", path: "/code/web", runnerId: other.id });
    return queueIn(otherRepo.id, other.id);
  };
  const tryClaim = (holder = "instance-1") =>
    inTransaction(db, async ({ workflowRun }) => {
      const next = await workflowRun.lockNextQueued(runnerId, "worktree");
      if (!next) return undefined;
      return workflowRun.claim(next.id, {
        runnerId,
        holder,
        sandboxKind: "worktree",
        leaseSeconds: defaultLeaseTimes.leaseSeconds,
      });
    });
  const claim = async (holder = "instance-1") => {
    const run = await tryClaim(holder);
    if (!run) throw new Error("No run was claimed");
    return run;
  };
  const readRow = async (id: number) =>
    (await db.select().from(workflowRuns).where(eq(workflowRuns.id, id)))[0];
  const queueWithNoRunner = () => queueIn(repo.id, null);
  return {
    db,
    runnerId,
    repo,
    runs,
    queueIn,
    queue,
    queueOnOtherRunner,
    queueWithNoRunner,
    claim,
    tryClaim,
    readRow,
  };
};

describe("WorkflowRunRepository", () => {
  it.each([
    ["an untrusted run", { isUntrusted: true }],
    ["a test run", { isTestRun: true }],
  ])(
    "gives %s to no process of the worktree kind, also when the runner row says devcontainer",
    async (_name, mark) => {
      const context = await setUp();
      await context.queueIn(context.repo.id, context.runnerId, {
        devcontainer: ".devcontainer/devcontainer.json",
        ...mark,
      });
      await createRepositories(context.db).runner.report(context.runnerId, testKeyOf("local"), {
        capabilities: devcontainerRunner,
        runnerProtocolVersion: protocolVersion,
        server: { buildId: devcontainerRunner.build.id, hasPackage: false },
      });

      const lockFor = (kind: "worktree" | "devcontainer") =>
        inTransaction(context.db, ({ workflowRun }) =>
          workflowRun.lockNextQueued(context.runnerId, kind),
        );

      expect(await lockFor("worktree")).toBeUndefined();
      expect(await lockFor("devcontainer")).toBeDefined();
    },
  );

  it("keeps a run with no runner on the runner that claims it", async () => {
    const { runnerId, queueWithNoRunner, claim, readRow, runs } = await setUp();
    const { id } = await queueWithNoRunner();

    const { leaseToken } = await claim();

    expect((await readRow(id))?.runnerId).toBe(runnerId);
    await runs.requeue(id, leaseToken);
    expect((await readRow(id))?.runnerId).toBe(runnerId);
  });

  it("lists a queued run with no runner for a runner", async () => {
    const { runnerId, queueWithNoRunner, runs } = await setUp();
    const { id } = await queueWithNoRunner();

    expect(await runs.listQueuedIdsByRunner(runnerId)).toEqual([{ id }]);
  });

  it("creates a queued run without a lease", async () => {
    const { repo, queue } = await setUp();

    expect(await queue()).toMatchObject({ repoId: repo.id, status: "queued", leaseToken: null });
  });

  it("names the branch after the id of the run", async () => {
    const { queue } = await setUp();
    await queue();

    expect(await queue()).toMatchObject({ id: 2, branch: "halinka/run-2" });
  });

  it("claims the oldest queued run under a new lease, with its workflow", async () => {
    const { queue, claim, readRow } = await setUp();
    const first = await queue();
    await queue();

    const claimed = await claim();

    expect(claimed).toMatchObject({ id: first.id, workflow: workflow.resolved });
    expect(await readRow(first.id)).toMatchObject({
      status: "running",
      leaseToken: claimed.leaseToken,
      leaseHolder: "instance-1",
    });
  });

  it("takes a different run on each claim, then nothing", async () => {
    const { queue, claim, tryClaim } = await setUp();
    await queue();
    await queue();

    const [a, b] = await Promise.all([claim("instance-1"), claim("instance-2")]);

    expect(a.id).not.toBe(b.id);
    expect(await tryClaim()).toBeUndefined();
  });

  it("claims only the runs of repos on its runner", async () => {
    const { queue, queueOnOtherRunner, claim } = await setUp();
    await queueOnOtherRunner();
    const own = await queue();

    const claimed = await claim();

    expect(claimed.id).toBe(own.id);
  });

  it("finishes a run under its lease once", async () => {
    const { runs, queue, claim, readRow } = await setUp();
    const run = await queue();
    const { leaseToken } = await claim();

    expect(await runs.finish(run.id, leaseToken, { status: "succeeded" })).toEqual({ id: run.id });
    expect(await readRow(run.id)).toMatchObject({
      status: "succeeded",
      leaseToken: null,
      finishedAt: expect.any(Date),
    });
    expect(await runs.finish(run.id, leaseToken, { status: "failed" })).toBeUndefined();
  });

  it("does not finish a run under another lease", async () => {
    const { runs, queue, claim, readRow } = await setUp();
    const run = await queue();
    await claim();

    expect(await runs.finish(run.id, "another-lease", { status: "failed" })).toBeUndefined();
    expect((await readRow(run.id))?.status).toBe("running");
  });
});
