import { conflict, connectionClosed, invalidDefinitions, invalidInput } from "@halinka/protocol";
import { hashOf } from "@halinka/utils/hash";
import { describe, expect, it } from "vitest";

import { createRepositories } from "../db/repositories";
import { repos } from "../db/schema";
import {
  createConnectedTestServer,
  createTestServer,
  linkPath,
  makeGitHubRepo,
  registerTestRunner,
  repoPath,
  setUpTestDb,
  testApiUrl,
} from "../testing";

const testDb = setUpTestDb();

describe("GET /api/repos", () => {
  it("lists the registered repos", async () => {
    const { api, runnerId } = await createTestServer(testDb());
    await api.repos.register({ runnerId, path: repoPath });

    expect(await api.repos.list()).toEqual([
      { id: 1, kind: "local", name: "app", path: repoPath, runnerId },
    ]);
  });
});

const repoRows = () => testDb().select().from(repos);

describe("DELETE /api/repos/{id}", () => {
  it("deletes a repo without runs at once", async () => {
    const { api, runnerId } = await createTestServer(testDb());
    await api.repos.register({ runnerId, path: repoPath });

    expect(await api.repos.delete({ id: 1 })).toEqual({ id: 1, isDeleted: true });
    expect(await repoRows()).toEqual([]);
  });

  it("refuses a repo with an active run", async () => {
    const { api, queue } = await createConnectedTestServer(testDb());
    await queue();

    await expect(api.repos.delete({ id: 1 })).rejects.toMatchObject({ status: 409 });
  });

  it("hides a repo whose runs the runner still has sandboxes of", async () => {
    const { api, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();

    expect(await api.repos.delete({ id: 1 })).toEqual({ id: 1, isDeleted: false });
    expect(await api.repos.list()).toEqual([]);
  });

  it("wakes the runner of each run of the repo", async () => {
    const { api, commands, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();
    await makeGitHubRepo(testDb(), 1, 100);
    commands.wake.mockClear();

    await api.repos.delete({ id: 1 });

    expect(commands.wake).toHaveBeenCalled();
  });

  it("refuses to delete a repo that is being deleted", async () => {
    const { api, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();
    await api.repos.delete({ id: 1 });

    await expect(api.repos.delete({ id: 1 })).rejects.toMatchObject({ status: 404 });
  });
});

describe("reportSandbox", () => {
  it("deletes a deleting repo when the sandbox of its last run is gone", async () => {
    const { api, plane, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();
    await api.repos.delete({ id: 1 });

    await plane.reportSandbox({ workflowRunId: 1, generation: 3, observed: "absent" });

    expect(await repoRows()).toEqual([]);
  });

  it("keeps a deleting repo while another of its runs has a sandbox", async () => {
    const { api, plane, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();
    await finishOne();
    await api.repos.delete({ id: 1 });

    await plane.reportSandbox({ workflowRunId: 1, generation: 3, observed: "absent" });

    expect(await repoRows()).toHaveLength(1);
  });
});

describe("POST /api/runners/{id}/revoke", () => {
  it("removes the deleting repos of a runner that an Admin revokes", async () => {
    const { api, runnerId, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();
    await api.repos.delete({ id: 1 });

    await api.runners.revoke({ id: runnerId });

    expect(await repoRows()).toEqual([]);
  });
});

describe("POST /api/runs", () => {
  it("starts no run in a repo that is being deleted", async () => {
    const { api, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();
    await api.repos.delete({ id: 1 });

    await expect(api.runs.create({ repoId: 1, workflow: "build" })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("POST /api/repos", () => {
  it("registers a folder with .halinka/config.yml once", async () => {
    const { api, runnerId } = await createTestServer(testDb());
    const repo = await api.repos.register({ runnerId, path: repoPath });
    expect(repo).toEqual({
      id: 1,
      kind: "local",
      name: "app",
      path: repoPath,
      runnerId,
    });
    expect(await api.repos.register({ runnerId, path: repoPath })).toEqual(repo);
  });

  it("registers the repo on the given runner", async () => {
    await registerTestRunner(testDb(), "other");
    const { api, runnerId } = await createTestServer(testDb());

    const { id } = await api.repos.register({ runnerId, path: repoPath });

    expect(await createRepositories(testDb()).repo.findById(id)).toMatchObject({ runnerId });
  });

  it("registers a symlink path under the real path and its name", async () => {
    const { api, runnerId } = await createTestServer(testDb());

    const repo = await api.repos.register({ runnerId, path: linkPath });

    expect(repo).toMatchObject({ name: "app", path: repoPath });
  });

  it("gives one repo for a symlink path and the real path", async () => {
    const { api, runnerId } = await createTestServer(testDb());
    const { id } = await api.repos.register({ runnerId, path: linkPath });

    expect(await api.repos.register({ runnerId, path: repoPath })).toMatchObject({ id });
  });

  it("refuses a relative path", async () => {
    const { api, runnerId } = await createTestServer(testDb());

    await expect(api.repos.register({ runnerId, path: "app" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
      defined: true,
      data: { issues: [{ path: ["path"], message: "Use an absolute path" }] },
    });
  });

  it("answers REPO_NOT_SET_UP with the devcontainers of a folder without .halinka/config.yml", async () => {
    const { api, runnerId, commands } = await createTestServer(testDb());
    commands.listDevcontainers.mockResolvedValueOnce([".devcontainer.json"]);

    await expect(api.repos.register({ runnerId, path: "/code/other" })).rejects.toMatchObject({
      code: "REPO_NOT_SET_UP",
      status: 400,
      message: "/code/other has no .halinka/config.yml",
      data: { devcontainers: [".devcontainer.json"] },
    });
  });

  it("answers 404 for a runner that does not exist", async () => {
    const { api } = await createTestServer(testDb());

    await expect(api.repos.register({ runnerId: 99, path: repoPath })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "There is no runner 99",
    });
  });

  it("answers 400 with the reason when the runner refuses the folder", async () => {
    const { api, runnerId, commands } = await createTestServer(testDb());
    commands.readRepo.mockRejectedValueOnce(invalidInput(`${repoPath} is not a git repo`));

    await expect(api.repos.register({ runnerId, path: repoPath })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
      message: `${repoPath} is not a git repo`,
    });
  });

  it("answers 503 when the runner disconnects during the read", async () => {
    const { api, runnerId, commands } = await createTestServer(testDb());
    commands.readRepo.mockRejectedValueOnce(connectionClosed());

    await expect(api.repos.register({ runnerId, path: repoPath })).rejects.toMatchObject({
      status: 503,
    });
  });

  it("answers 503 when the given runner is not connected", async () => {
    const { api, commands } = await createTestServer(testDb());
    const other = await registerTestRunner(testDb(), "other");

    await expect(api.repos.register({ runnerId: other.id, path: repoPath })).rejects.toMatchObject({
      code: "RUNNER_OFFLINE",
      status: 503,
      message: "The runner is not connected",
    });
    expect(commands.readRepo).not.toHaveBeenCalled();
  });

  it("refuses to register the path of a repo that is being deleted", async () => {
    const { api, runnerId, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();
    await api.repos.delete({ id: 1 });

    await expect(api.repos.register({ runnerId, path: repoPath })).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe("POST /api/repos/init", () => {
  const notSetUp = async (options: { isRemoteRunner?: boolean } = {}) => {
    const server = await createTestServer(testDb(), options);
    delete server.files[".halinka/config.yml"];
    return server;
  };

  it("writes server: local for a folder of the local runner", async () => {
    const { api, runnerId, files } = await notSetUp();

    await api.repos.init({ runnerId, path: repoPath });

    expect(files[".halinka/config.yml"]).toBe("schema_version: 1\nserver: local\n");
  });

  it("registers a folder of the local runner", async () => {
    const { api, runnerId } = await notSetUp();

    const repo = await api.repos.init({ runnerId, path: repoPath });

    expect(repo).toEqual({
      id: 1,
      kind: "local",
      name: "app",
      path: repoPath,
      runnerId,
    });
  });

  it("writes the URL of the server for a folder of a remote runner", async () => {
    const { api, runnerId, files } = await notSetUp({ isRemoteRunner: true });

    await api.repos.init({ runnerId, path: repoPath, devcontainer: ".devcontainer.json" });

    expect(files[".halinka/config.yml"]).toBe(
      `schema_version: 1\nserver: ${testApiUrl}\ndevcontainer: .devcontainer.json\n`,
    );
  });

  it("answers 400 with the reason when the runner refuses the setup", async () => {
    const { api, runnerId, commands } = await notSetUp();
    commands.setUpRepo.mockRejectedValueOnce(invalidInput(`${repoPath} has .halinka/`));

    await expect(api.repos.init({ runnerId, path: repoPath })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: `${repoPath} has .halinka/`,
    });
  });

  it("registers no repo when the read after the setup fails", async () => {
    const { api, runnerId, commands } = await notSetUp();
    commands.readRepo.mockRejectedValueOnce(invalidDefinitions(".halinka/ cannot be read"));

    await expect(api.repos.init({ runnerId, path: repoPath })).rejects.toMatchObject({
      code: "INVALID_DEFINITIONS",
    });
    expect(await testDb().select().from(repos)).toEqual([]);
  });

  it("answers 404 for a runner that does not exist", async () => {
    const { api } = await notSetUp();

    await expect(api.repos.init({ runnerId: 99, path: repoPath })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("GET /api/repos/{id}/workflows", () => {
  it("lists the .yml and .yaml files in .halinka/workflows/ with their names", async () => {
    const { api, files } = await createConnectedTestServer(testDb());
    files[".halinka/workflows/fix.yaml"] =
      "schema_version: 1\nname: Fix\nsteps:\n  - id: fix\n    type: shell\n    run: ls\n";

    expect((await api.repos.workflows({ id: 1 })).workflows).toEqual([
      { path: ".halinka/workflows/build.yml", name: "Build", inputs: {}, problems: [] },
      { path: ".halinka/workflows/fix.yaml", name: "Fix", inputs: {}, problems: [] },
    ]);
  });

  it("lists the workflows in path order", async () => {
    const { api, files } = await createConnectedTestServer(testDb());
    files[".halinka/workflows/a.yml"] = "steps: []\n";

    expect((await api.repos.workflows({ id: 1 })).workflows.map(({ path }) => path)).toEqual([
      ".halinka/workflows/a.yml",
      ".halinka/workflows/build.yml",
    ]);
  });

  it("gives the inputs that a workflow declares", async () => {
    const { api, files } = await createConnectedTestServer(testDb());
    files[".halinka/workflows/build.yml"] = [
      "schema_version: 1",
      "name: Build",
      "inputs:",
      "  issue: { type: number, required: true, description: The issue }",
      "  draft: { type: boolean, default: false }",
      "steps:",
      "  - id: build",
      "    type: shell",
      "    run: ls",
    ].join("\n");

    const [workflow] = (await api.repos.workflows({ id: 1 })).workflows;

    expect(workflow?.inputs).toEqual({
      issue: { type: "number", required: true, description: "The issue" },
      draft: { type: "boolean", default: false },
    });
  });

  it("gives the problems of a file that is not a valid workflow", async () => {
    const { api, files } = await createConnectedTestServer(testDb());
    files[".halinka/workflows/build.yml"] = "schema_version: 1\nsteps: []\n";

    expect((await api.repos.workflows({ id: 1 })).workflows).toEqual([
      {
        path: ".halinka/workflows/build.yml",
        problems: [
          expect.objectContaining({ line: 1, path: ["name"], message: "Required" }),
          expect.objectContaining({ line: 2, path: ["steps"], message: "Add at least one step" }),
        ],
      },
    ]);
  });

  it("gives a problem for an agent that is not a preset", async () => {
    const { api, files } = await createConnectedTestServer(testDb());
    files[".halinka/workflows/build.yml"] =
      "schema_version: 1\nname: Build\nsteps:\n  - { id: fix, type: agent, agent: gemini, prompt: Fix }\n";

    const [workflow] = (await api.repos.workflows({ id: 1 })).workflows;

    expect(workflow?.problems).toMatchObject([{ path: ["steps", 0, "agent"] }]);
  });

  it("gives the problems of config.yml", async () => {
    const { api, files } = await createConnectedTestServer(testDb());
    files[".halinka/config.yml"] = "server: local\n";

    expect((await api.repos.workflows({ id: 1 })).configProblems).toEqual([
      expect.objectContaining({ path: ["schema_version"] }),
    ]);
  });

  it("lists only workflow paths", async () => {
    const { api, files } = await createConnectedTestServer(testDb());
    files[".halinka/workflows/nested/fix.yml"] = "schema_version: 1\nname: Fix\n";

    expect((await api.repos.workflows({ id: 1 })).workflows).toEqual([
      { path: ".halinka/workflows/build.yml", name: "Build", inputs: {}, problems: [] },
    ]);
  });

  it("answers 422 with the reason when the runner cannot use .halinka/", async () => {
    const { api, commands } = await createConnectedTestServer(testDb());
    commands.readRepo.mockRejectedValueOnce(
      invalidDefinitions(".halinka/ has more than 200 files"),
    );

    await expect(api.repos.workflows({ id: 1 })).rejects.toMatchObject({
      code: "INVALID_DEFINITIONS",
      status: 422,
      message: ".halinka/ has more than 200 files",
    });
  });

  it("answers 404 for an unknown repo", async () => {
    const { api } = await createTestServer(testDb());

    await expect(api.repos.workflows({ id: 1 })).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
      message: "There is no repo 1",
    });
  });
});

describe("GET /api/repos/{id}/workflows/{workflow}", () => {
  it("gives the source and the workflow of a file by its file name", async () => {
    const { api, files } = await createConnectedTestServer(testDb());
    const source =
      "schema_version: 1\nname: Fix\nsteps:\n  - id: fix\n    type: shell\n    run: ls\n";
    files[".halinka/workflows/my fix.yaml"] = source;

    expect(await api.repos.workflow({ id: 1, workflow: "my fix.yaml" })).toEqual({
      path: ".halinka/workflows/my fix.yaml",
      source,
      hash: hashOf(source),
      workflow: { name: "Fix", steps: [{ id: "fix", type: "shell", run: "ls" }] },
      problems: [],
    });
  });

  it("gives the problems of an agent that is not a preset", async () => {
    const { api, files } = await createConnectedTestServer(testDb());
    files[".halinka/workflows/build.yml"] =
      "schema_version: 1\nname: Build\nsteps:\n  - { id: fix, type: agent, agent: gemini, prompt: Fix }\n";

    expect(await api.repos.workflow({ id: 1, workflow: "build.yml" })).toMatchObject({
      problems: [
        {
          line: 4,
          path: ["steps", 0, "agent"],
          message: expect.stringContaining('There is no agent "gemini"'),
        },
      ],
    });
  });

  it("answers 404 for an unknown workflow", async () => {
    const { api } = await createConnectedTestServer(testDb());

    await expect(api.repos.workflow({ id: 1, workflow: "deploy.yml" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "There is no workflow deploy.yml",
    });
  });

  it("refuses a name that is not a workflow reference", async () => {
    const { api } = await createConnectedTestServer(testDb());

    await expect(api.repos.workflow({ id: 1, workflow: "readme.md" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Use a workflow name, a file name or a path in .halinka/workflows/",
    });
  });
});

describe("PUT /api/repos/{id}/workflows/{workflow}", () => {
  const source =
    "schema_version: 1\nname: Fix\nsteps:\n  - id: fix\n    type: shell\n    run: ls\n";

  it("refuses a repo on GitHub", async () => {
    const { api, commands } = await createConnectedTestServer(testDb());
    await makeGitHubRepo(testDb(), 1, 100);

    const write = api.repos.writeWorkflow({ id: 1, workflow: "fix.yml", source });

    await expect(write).rejects.toMatchObject({ code: "CONFLICT" });
    expect(commands.writeRepoFile).not.toHaveBeenCalled();
  });

  it("creates a workflow file by its file name", async () => {
    const { api, commands } = await createConnectedTestServer(testDb());

    const written = await api.repos.writeWorkflow({
      id: 1,
      workflow: "fix.yml",
      source,
    });

    expect(written).toEqual({ path: ".halinka/workflows/fix.yml", hash: hashOf(source) });
    expect(commands.writeRepoFile).toHaveBeenCalledWith({
      repoPath,
      path: ".halinka/workflows/fix.yml",
      source,
    });
  });

  it("replaces a workflow file by its path with the hash of the read", async () => {
    const { api, commands } = await createConnectedTestServer(testDb());
    const { path, hash } = await api.repos.workflow({ id: 1, workflow: "build" });

    await api.repos.writeWorkflow({ id: 1, workflow: path, source, hash });

    expect(commands.writeRepoFile).toHaveBeenCalledWith({
      repoPath,
      path,
      source,
      expectedHash: hash,
    });
  });

  it("refuses a bare name", async () => {
    const { api, commands } = await createConnectedTestServer(testDb());

    await expect(api.repos.writeWorkflow({ id: 1, workflow: "fix", source })).rejects.toMatchObject(
      {
        code: "BAD_REQUEST",
        message: "Use a workflow file name or a path in .halinka/workflows/",
      },
    );
    expect(commands.writeRepoFile).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown repo", async () => {
    const { api } = await createConnectedTestServer(testDb());

    await expect(
      api.repos.writeWorkflow({ id: 9, workflow: "fix.yml", source }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("answers 409 when the runner finds another file", async () => {
    const { api, commands } = await createConnectedTestServer(testDb());
    commands.writeRepoFile.mockRejectedValueOnce(
      conflict(".halinka/workflows/build.yml changed since it was read"),
    );

    await expect(
      api.repos.writeWorkflow({ id: 1, workflow: "build.yml", source, hash: "0" }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
      message: ".halinka/workflows/build.yml changed since it was read",
    });
  });

  it("answers 503 when the runner disconnects during the write", async () => {
    const { api, commands } = await createConnectedTestServer(testDb());
    commands.writeRepoFile.mockRejectedValueOnce(connectionClosed());

    await expect(
      api.repos.writeWorkflow({ id: 1, workflow: "fix.yml", source }),
    ).rejects.toMatchObject({ code: "RUNNER_OFFLINE", status: 503 });
  });
});
