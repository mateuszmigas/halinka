import { describe, expect, it } from "vitest";

import { registerTestRunner, setUpTestDb } from "../../testing";
import { repoSecrets, repos as repoRows, workflowSnapshots } from "../schema";
import { createRepositories } from "./createRepositories";

const testDb = setUpTestDb();

const setUp = async () => {
  const { repo: repos } = createRepositories(testDb());
  const { id: runnerId } = await registerTestRunner(testDb(), "local");
  return { repos, repo: { name: "app", path: "/code/app", runnerId } };
};

describe("RepoRepository", () => {
  it("registers a path", async () => {
    const { repos, repo } = await setUp();

    expect(await repos.register(repo)).toEqual({
      ...repo,
      id: 1,
      kind: "local",
      githubRepoId: null,
      deletingAt: null,
      createdAt: expect.any(Date),
    });
  });

  it("gives the same repo at a second register of a path", async () => {
    const { repos, repo } = await setUp();
    const first = await repos.register(repo);

    expect(await repos.register({ ...repo, name: "other" })).toEqual(first);
  });

  it("registers one path on two runners as two repos", async () => {
    const { repos, repo } = await setUp();
    const other = await registerTestRunner(testDb(), "other");
    const first = await repos.register(repo);

    const second = await repos.register({ ...repo, runnerId: other.id });

    expect(second.id).not.toBe(first.id);
  });

  it("finds a repo by id", async () => {
    const { repos, repo } = await setUp();
    const { id } = await repos.register(repo);
    expect(await repos.findById(id)).toMatchObject(repo);
    expect(await repos.findById(id + 1)).toBeUndefined();
  });

  it("deletes a deleting repo that has no runs", async () => {
    const { repos, repo } = await setUp();
    const { id } = await repos.register(repo);
    await repos.markDeleting(id);

    await repos.deleteGone();

    expect(await testDb().select().from(repoRows)).toEqual([]);
  });

  it("deletes the secrets and the snapshots of a deleted repo", async () => {
    const { repos, repo } = await setUp();
    const { id: repoId } = await repos.register(repo);
    const { repoSecret, workflowSnapshot } = createRepositories(testDb());
    await repoSecret.save({ repoId, name: "NPM_TOKEN", sealed: "sealed" });
    const resolved = {
      name: "Build",
      steps: [{ id: "build", type: "shell" as const, run: "ls" }],
    };
    const files = { ".halinka/workflows/build.yml": "schema_version: 1\nname: Build\n" };
    await workflowSnapshot.findOrCreate({
      repoId,
      path: ".halinka/workflows/build.yml",
      files,
      resolved,
      runsOn: [],
      agents: [],
    });
    await repos.markDeleting(repoId);

    await repos.deleteGone();

    expect(await testDb().select().from(repoSecrets)).toEqual([]);
    expect(await testDb().select().from(workflowSnapshots)).toEqual([]);
  });

  it("deletes no repo that is not deleting", async () => {
    const { repos, repo } = await setUp();
    await repos.register(repo);

    await repos.deleteGone();

    expect(await testDb().select().from(repoRows)).toHaveLength(1);
  });
});
