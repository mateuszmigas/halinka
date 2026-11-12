import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import {
  cleanTestDb,
  createConnectedTestServer,
  setUpTestPostgres,
  worktreeRunner,
} from "../../testing";
import { workflowRuns } from "../schema";
import { inTransaction } from "./createRepositories";

const deployWorkflow = (...fields: string[]) =>
  [
    "schema_version: 1",
    "name: Deploy",
    "concurrency:",
    "  group: deploy",
    ...fields,
    "steps:",
    "  - { id: build, type: shell, run: ls }",
  ].join("\n");

describe("concurrency groups on Postgres", () => {
  const postgres = setUpTestPostgres();
  const { openTransaction } = postgres;

  const setUp = async (source = deployWorkflow()) => {
    const { db } = postgres.connection();
    await cleanTestDb(db);
    const server = await createConnectedTestServer(db);
    server.files[".halinka/workflows/deploy.yml"] = source;
    await server.plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });
    const start = () => server.api.runs.create({ repoId: 1, workflow: "deploy" });
    return { ...server, start };
  };

  it("does not claim a reopened lower run during a claim of a higher run", async () => {
    const { runnerId, start } = await setUp();
    const lower = await start();
    const higher = await start();
    const { db } = postgres.connection();
    await db.update(workflowRuns).set({ status: "succeeded" }).where(eq(workflowRuns.id, lower.id));
    const claim = await openTransaction(({ workflowRun }) =>
      workflowRun.lockNextQueued(runnerId, "worktree"),
    );

    await db.update(workflowRuns).set({ status: "queued" }).where(eq(workflowRuns.id, lower.id));
    const second = await inTransaction(db, ({ workflowRun }) =>
      workflowRun.lockNextQueued(runnerId, "worktree"),
    );

    claim.release();
    await claim.done;
    expect({ first: claim.result?.id, second }).toEqual({ first: higher.id, second: undefined });
  });

  it("does not deadlock a new cancelling run with a leased write", async () => {
    const { start } = await setUp(deployWorkflow("  cancel_in_progress: true"));
    const older = await start();
    const write = await openTransaction(({ workflowRun }) => workflowRun.lockById(older.id));

    const created = start();
    await vi.waitFor(async () => {
      expect(await postgres.connection().db.select().from(workflowRuns)).toHaveLength(2);
    });
    await inTransaction(postgres.connection().db, (repositories) =>
      repositories.repo.lockById(1, "share"),
    );
    write.release();
    await write.done;

    await expect(created).resolves.toMatchObject({ status: "queued" });
  });
});
