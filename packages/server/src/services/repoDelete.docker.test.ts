import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { workflowRuns } from "../db/schema";
import {
  cleanTestDb,
  createConnectedTestServer,
  setUpTestPostgres,
  worktreeRunner,
} from "../testing";

const buildWorkflow =
  "schema_version: 1\nname: Build\nsteps:\n  - { id: build, type: shell, run: ls }\n";

describe("repo delete on Postgres", () => {
  const postgres = setUpTestPostgres();

  const setUp = async () => {
    const { db } = postgres.connection();
    await cleanTestDb(db);
    const server = await createConnectedTestServer(db);
    server.files[".halinka/workflows/build.yml"] = buildWorkflow;
    await server.plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });
    const { id } = await server.api.runs.create({ repoId: 1, workflow: "build" });
    await db.update(workflowRuns).set({ status: "succeeded" }).where(eq(workflowRuns.id, id));
    return { ...server, id };
  };

  it("refuses a repo delete while another transaction holds a run of the repo", async () => {
    const { api, id } = await setUp();
    const reopen = await postgres.openTransaction(({ workflowRun }) => workflowRun.lockById(id));

    const deleted = api.repos.delete({ id: 1 });

    await expect(deleted).rejects.toMatchObject({ status: 409 });
    reopen.release();
    await reopen.done;
  });
});
