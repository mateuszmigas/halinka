import { describe, expect, it } from "vitest";

import { registerTestRunner, setUpTestDb } from "../../testing";
import { createRepositories } from "./createRepositories";

const path = ".halinka/workflows/build.yml";
const resolved = { name: "Build", steps: [{ id: "build", type: "shell" as const, run: "ls" }] };
const dispatch = { runsOn: [], agents: [] };

const testDb = setUpTestDb();

const setUp = async () => {
  const { repo: repos, workflowSnapshot } = createRepositories(testDb());
  const { id: runnerId } = await registerTestRunner(testDb(), "local");
  const repo = await repos.register({ name: "app", path: "/code/app", runnerId });
  return { repoId: repo.id, snapshots: workflowSnapshot };
};

describe("WorkflowSnapshotRepository", () => {
  it("stores the files, the resolved workflow and a hash of the files", async () => {
    const { repoId, snapshots } = await setUp();
    const files = { [path]: "schema_version: 1\nname: Build\n" };
    expect(await snapshots.findOrCreate({ repoId, path, files, resolved, ...dispatch })).toEqual({
      id: 1,
      repoId,
      path,
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      files,
      resolved,
      devcontainer: null,
      setupNetwork: [],
      setupRun: null,
      setupSecrets: [],
      setupDocker: false,
      ...dispatch,
      createdAt: expect.any(Date),
    });
  });

  it("gives the same snapshot for the same files", async () => {
    const { repoId, snapshots } = await setUp();
    const snapshotOf = (source: string) =>
      snapshots.findOrCreate({ repoId, path, files: { [path]: source }, resolved, ...dispatch });
    const first = await snapshotOf("a");

    expect((await snapshotOf("a")).id).toBe(first.id);
  });

  it("gives a new snapshot for changed files", async () => {
    const { repoId, snapshots } = await setUp();
    const snapshotOf = (source: string) =>
      snapshots.findOrCreate({ repoId, path, files: { [path]: source }, resolved, ...dispatch });
    const first = await snapshotOf("a");

    expect((await snapshotOf("b")).id).not.toBe(first.id);
  });
});
