import { hashOf } from "@halinka/utils/hash";
import { mib } from "@halinka/utils/repoFiles";
import { describe, expect, it } from "vitest";

import { createRepositories } from "../db/repositories";
import { workflowSnapshots } from "../db/schema";
import {
  connectApp,
  createConnectedTestServer,
  devcontainerConfig,
  FakeGitHub,
  gpuWorkflow,
  implementWorkflow,
  installationOf,
  repoOf,
  setUpTestDb,
  worktreeRunner,
} from "../testing";

const testDb = setUpTestDb();

const buildPath = ".halinka/workflows/build.yml";

const withApp = async () => {
  const server = await createConnectedTestServer(testDb());
  const gitHub = new FakeGitHub();
  await connectApp(server.api, gitHub, [installationOf(10, [repoOf(100, "app")])]);
  gitHub.repoFiles = { ...server.files };
  gitHub.requests.length = 0;
  server.commands.wake.mockClear();
  return { ...server, gitHub };
};

const added = async () => {
  const server = await withApp();
  const repo = await server.api.repos.createGitHub({ githubRepoId: 100 });
  server.gitHub.requests.length = 0;
  return { ...server, repo };
};

const blobReads = ({ requests }: FakeGitHub) =>
  requests.filter(({ url }) => url.pathname.includes("/git/blobs/"));

describe("POST /api/repos/github", () => {
  it("adds a stored repo of the App, with no runner and no path", async () => {
    const { repo } = await added();

    expect(repo).toEqual({ id: 2, kind: "github", name: "acme/app", githubRepoId: 100 });
  });

  it("gives the same row at a second add", async () => {
    const { api, repo } = await added();

    expect((await api.repos.createGitHub({ githubRepoId: 100 })).id).toBe(repo.id);
  });

  it("refuses a repo that the App has no access to", async () => {
    const { api } = await withApp();

    await expect(api.repos.createGitHub({ githubRepoId: 999 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("refuses a repo that is being deleted", async () => {
    const { api, repo } = await added();
    await createRepositories(testDb()).repo.markDeleting(repo.id);

    await expect(api.repos.createGitHub({ githubRepoId: 100 })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("GET /api/repos/{id}/workflows", () => {
  it("lists the workflows of the default branch", async () => {
    const { api, gitHub, repo } = await added();
    gitHub.defaultBranch = "release/1";

    expect((await api.repos.workflows({ id: repo.id })).workflows).toMatchObject([
      { path: buildPath, name: "Build" },
    ]);
  });

  it("reads with a token of that repo that cannot write", async () => {
    const { api, gitHub, repo } = await added();

    await api.repos.workflows({ id: repo.id });

    expect(gitHub.readsOf("/app/installations/10/access_tokens").map(({ body }) => body)).toEqual([
      { repository_ids: [100], permissions: { contents: "read", metadata: "read" } },
    ]);
  });

  it.each([
    { kind: "a symlink", mode: "120000" },
    { kind: "a submodule", mode: "160000" },
  ])("leaves out $kind", async ({ mode }) => {
    const { api, gitHub, repo } = await added();
    gitHub.repoFiles[".halinka/workflows/link.yml"] = buildPath;
    gitHub.fileModes[".halinka/workflows/link.yml"] = mode;

    const { workflows } = await api.repos.workflows({ id: repo.id });

    expect(workflows.map(({ path }) => path)).toEqual([buildPath]);
  });

  it("gives no workflows for a repo with no definitions", async () => {
    const { api, gitHub, repo } = await added();
    gitHub.repoFiles = { "README.md": "Hello" };

    expect(await api.repos.workflows({ id: repo.id })).toEqual({
      configProblems: [],
      workflows: [],
    });
  });

  it("refuses a file in place of the folder", async () => {
    const { api, gitHub, repo } = await added();
    gitHub.repoFiles = { ".halinka": "not a folder" };

    await expect(api.repos.workflows({ id: repo.id })).rejects.toMatchObject({
      code: "INVALID_DEFINITIONS",
    });
  });

  it("refuses a root listing that GitHub cut before it found the folder", async () => {
    const { api, gitHub, repo } = await added();
    gitHub.repoFiles = { "README.md": "Hello" };
    gitHub.isTruncated = true;

    await expect(api.repos.workflows({ id: repo.id })).rejects.toMatchObject({
      code: "INVALID_DEFINITIONS",
    });
  });

  it("refuses a listing of the folder that GitHub cut", async () => {
    const { api, gitHub, repo } = await added();
    gitHub.isTruncated = true;

    await expect(api.repos.workflows({ id: repo.id })).rejects.toMatchObject({
      code: "INVALID_DEFINITIONS",
    });
    expect(blobReads(gitHub)).toEqual([]);
  });

  it.each([
    {
      limit: "more than 200 files",
      files: Object.fromEntries(
        Array.from({ length: 201 }, (_, index) => [`.halinka/${index}.txt`, ""]),
      ),
    },
    {
      limit: "a file larger than 1 MiB",
      files: { ".halinka/large.txt": "x".repeat(mib + 1) },
    },
    {
      limit: "more than 4 MiB",
      files: Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [`.halinka/${index}.txt`, "x".repeat(mib)]),
      ),
    },
  ])("refuses $limit, and reads no file", async ({ files }) => {
    const { api, gitHub, repo } = await added();
    gitHub.repoFiles = files;

    await expect(api.repos.workflows({ id: repo.id })).rejects.toMatchObject({
      code: "INVALID_DEFINITIONS",
    });
    expect(blobReads(gitHub)).toEqual([]);
  });

  it("needs the App", async () => {
    const { api, repo } = await added();
    await api.github.disconnect();

    await expect(api.repos.workflows({ id: repo.id })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("needs the App"),
    });
  });
});

describe("GET /api/repos/{id}/workflows/{workflow}", () => {
  it("gives the hash of the bytes of the file", async () => {
    const { api, gitHub, repo } = await added();
    const source = gitHub.repoFiles[buildPath]!;

    expect(await api.repos.workflow({ id: repo.id, workflow: "build" })).toMatchObject({
      source,
      hash: hashOf(source),
    });
  });
});

const runRow = (id: number) => createRepositories(testDb()).workflowRun.findById(id);

const withGpuWorkflow = async () => {
  const server = await added();
  server.gitHub.repoFiles[".halinka/workflows/gpu.yml"] = gpuWorkflow;
  const { id } = await server.api.runs.create({ repoId: server.repo.id, workflow: "gpu" });
  return { ...server, id };
};

const withBranch = async () => {
  const server = await added();
  server.gitHub.repoFiles[".halinka/workflows/fix.yml"] = [
    "schema_version: 1",
    "name: Fix",
    "branch: { name: halinka/fix }",
    "steps:",
    "  - { id: fix, type: shell, run: ls }",
  ].join("\n");
  const create = () => server.api.runs.create({ repoId: server.repo.id, workflow: "fix" });
  const { id } = await create();
  await server.api.runs.cancel({ id });
  return { ...server, create, id };
};

const queued = async () => {
  const server = await added();
  const { id } = await server.api.runs.create({ repoId: server.repo.id, workflow: "build" });
  return { ...server, id };
};

const queuedAgentRun = async () => {
  const server = await added();
  server.gitHub.repoFiles[".halinka/workflows/implement.yml"] = implementWorkflow;
  const { id } = await server.api.runs.create({
    repoId: server.repo.id,
    workflow: "implement",
  });
  return { ...server, id };
};

describe("POST /api/runs", () => {
  it("starts at the tip of the default branch with no runner", async () => {
    const { api, gitHub, repo } = await added();

    const { id } = await api.runs.create({ repoId: repo.id, workflow: "build" });

    expect(await runRow(id)).toMatchObject({ runnerId: null, baseSha: gitHub.head });
  });

  it("wakes a connected runner", async () => {
    const { api, commands, repo } = await added();

    await api.runs.create({ repoId: repo.id, workflow: "build" });

    expect(commands.wake).toHaveBeenCalledOnce();
  });

  it("keeps the devcontainer text of its commit in the snapshot", async () => {
    const { api, gitHub, repo } = await added();
    gitHub.repoFiles[".halinka/config.yml"] = devcontainerConfig;
    gitHub.repoFiles[".devcontainer/devcontainer.json"] = '{ "image": "node" }';

    await api.runs.create({ repoId: repo.id, workflow: "build" });

    const [snapshot] = await testDb().select().from(workflowSnapshots);
    expect(snapshot).toMatchObject({
      devcontainer: ".devcontainer/devcontainer.json",
      files: { ".devcontainer/devcontainer.json": '{ "image": "node" }' },
    });
  });

  it("keeps no devcontainer text when the path is a symlink", async () => {
    const { api, gitHub, repo } = await added();
    gitHub.repoFiles[".halinka/config.yml"] = devcontainerConfig;
    gitHub.repoFiles[".devcontainer/devcontainer.json"] = "other.json";
    gitHub.fileModes[".devcontainer/devcontainer.json"] = "120000";

    await api.runs.create({ repoId: repo.id, workflow: "build" });

    const [snapshot] = await testDb().select().from(workflowSnapshots);
    expect(snapshot?.files).not.toHaveProperty([".devcontainer/devcontainer.json"]);
  });

  it("keeps no devcontainer text when a folder on the path is a file", async () => {
    const { api, gitHub, repo } = await added();
    gitHub.repoFiles[".halinka/config.yml"] = devcontainerConfig;
    gitHub.repoFiles[".devcontainer"] = "a file";

    await api.runs.create({ repoId: repo.id, workflow: "build" });

    const [snapshot] = await testDb().select().from(workflowSnapshots);
    expect(snapshot?.files).not.toHaveProperty([".devcontainer/devcontainer.json"]);
  });

  it("refuses a devcontainer file larger than 1 MiB", async () => {
    const { api, gitHub, repo } = await added();
    gitHub.repoFiles[".halinka/config.yml"] = devcontainerConfig;
    gitHub.repoFiles[".devcontainer/devcontainer.json"] = "x".repeat(mib + 1);

    await expect(api.runs.create({ repoId: repo.id, workflow: "build" })).rejects.toMatchObject({
      code: "INVALID_DEFINITIONS",
    });
  });

  it("refuses a branch name that a finished run holds", async () => {
    const { create, id } = await withBranch();

    await expect(create()).rejects.toMatchObject({
      code: "CONFLICT",
      message: `The run ${id} holds the branch halinka/fix. Delete that run, or use another branch name.`,
    });
  });

  it("refuses a branch name that a later run can get", async () => {
    const { api, gitHub, repo } = await added();
    gitHub.repoFiles[".halinka/workflows/fix.yml"] = [
      "schema_version: 1",
      "name: Fix",
      "branch: { name: halinka/run-7 }",
      "steps:",
      "  - { id: fix, type: shell, run: ls }",
    ].join("\n");

    await expect(api.runs.create({ repoId: repo.id, workflow: "fix" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("refuses a branch name that is the default branch", async () => {
    const { api, gitHub, repo } = await added();
    gitHub.defaultBranch = "release/1";
    gitHub.repoFiles[".halinka/workflows/fix.yml"] = [
      "schema_version: 1",
      "name: Fix",
      "inputs: { branch: { type: string, required: true } }",
      "branch: { name: '${{ inputs.branch }}' }",
      "steps:",
      "  - { id: fix, type: shell, run: ls }",
    ].join("\n");

    const create = api.runs.create({
      repoId: repo.id,
      workflow: "fix",
      inputs: { branch: "release/1" },
    });

    await expect(create).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "The branch release/1 is the default branch of the repo. Use another branch name.",
    });
  });

  it("refuses a new run of a disabled agent", async () => {
    const { api, gitHub, repo } = await added();
    gitHub.repoFiles[".halinka/workflows/implement.yml"] = implementWorkflow;
    await api.agents.update({ preset: "claude-code", isEnabled: false });

    await expect(api.runs.create({ repoId: repo.id, workflow: "implement" })).rejects.toThrow(
      "The agent claude-code is disabled",
    );
  });

  it("takes the branch name when that run is deleted", async () => {
    const { api, create, id } = await withBranch();

    await api.runs.delete({ id });

    await expect(create()).resolves.toMatchObject({ status: "queued" });
  });
});

describe("sync", () => {
  it("gives a run to the runner that syncs first", async () => {
    const { api, claimOne, repo, runnerId } = await added();
    const { id } = await api.runs.create({ repoId: repo.id, workflow: "build" });

    const claimed = await claimOne();

    expect(claimed).toMatchObject({ githubRepoId: 100 });
    expect(await runRow(id)).toMatchObject({ runnerId });
  });

  it("leaves a run that needs a label queued at a sync of a runner without it", async () => {
    const { id, plane } = await withGpuWorkflow();

    const { claimed } = await plane.sync({ held: [], capacity: 1, capabilities: worktreeRunner });

    expect(claimed).toEqual([]);
    expect(await runRow(id)).toMatchObject({ status: "queued", runnerId: null });
  });
});

describe("GET /api/runs/{id}", () => {
  it("names the label that a run needs in the wait reason", async () => {
    const { api, id } = await withGpuWorkflow();

    expect((await api.runs.get({ id })).waitReason).toBe(
      "No connected runner can take the run. It needs the labels gpu",
    );
  });

  it("names a runner with containers in the wait reason of an untrusted run", async () => {
    const { api, plane, repo, services } = await added();
    const read = await services.repo.readWorkflow(repo.id, "build");
    const { id } = await services.run.createFrom(repo.id, read, { isUntrusted: true });

    await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });

    expect((await api.runs.get({ id })).waitReason).toBe(
      "No connected runner can take the run. It needs a runner with containers",
    );
  });

  it("names a runner with containers in the wait reason of a test run", async () => {
    const { api, plane, repo } = await added();
    const { hash, source } = await api.repos.workflow({ id: repo.id, workflow: "build" });
    const { id } = await api.runs.test({
      repoId: repo.id,
      workflow: "build",
      source,
      baseHash: hash,
    });

    await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });

    expect((await api.runs.get({ id })).waitReason).toBe(
      "No connected runner can take the run. It needs a runner with containers",
    );
  });

  it("gives no wait reason when a connected runner can take the run", async () => {
    const { api, id, plane } = await queued();
    await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });

    expect((await api.runs.get({ id })).waitReason).toBeUndefined();
  });

  it("tells in the wait reason that no connected runner can take the run", async () => {
    const { api, disconnect, id } = await queued();
    disconnect();

    expect((await api.runs.get({ id })).waitReason).toBe("No connected runner can take the run");
  });

  it("names the agents that the run needs in the wait reason", async () => {
    const { api, id, plane } = await queuedAgentRun();
    await plane.sync({
      held: [],
      capacity: 0,
      capabilities: { ...worktreeRunner, agentsOnPath: [] },
    });

    expect((await api.runs.get({ id })).waitReason).toBe(
      "No connected runner can take the run. It needs the agents claude-code",
    );
  });

  it("tells in the wait reason that an agent of the run is disabled", async () => {
    const { api, id } = await queuedAgentRun();
    await api.agents.update({ preset: "claude-code", isEnabled: false });

    expect((await api.runs.get({ id })).waitReason).toBe(
      "The agent claude-code is disabled. An Admin can enable it on the Agents page",
    );
  });
});

describe("PATCH /api/runners/{id}", () => {
  it("signals a queued run when a runner changes", async () => {
    const { api, bus, id, runnerId } = await queued();
    const changes: string[] = [];
    bus.subscribe(id, (change) => changes.push(change));

    await api.runners.update({ id: runnerId, labels: ["new"] });

    expect(changes).toEqual(["state"]);
  });
});
