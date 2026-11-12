import {
  type AttemptItemKind,
  conflict,
  connectionClosed,
  ProtocolError,
  type RunLease,
  type RunnerCapabilities,
} from "@halinka/protocol";
import { getEventMeta } from "@orpc/client";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { isDefinedError } from "../client";
import { createRepositories } from "../db/repositories";
import {
  agentMessages,
  pushedBranches,
  runners,
  stepRuns,
  workflowRuns,
  workflowSnapshots,
} from "../db/schema";
import type { RunBus } from "../runBus";
import {
  agentPrompt,
  baseSha,
  connectApp,
  CountingBus,
  createConnectedTestServer,
  createTestServer,
  deliveringPrompt,
  devcontainerConfig,
  devcontainerRunner,
  FakeGitHub,
  gpuWorkflow,
  implementWorkflow,
  installationOf,
  makeGitHubRepo,
  publishWorkflow,
  repoOf,
  repoPath,
  secondRepoPath,
  setUpTestDb,
  testCheckpoint,
  testQuestions,
  testSshHostKey,
  worktreeRunner,
} from "../testing";

const testDb = setUpTestDb();

const withConfig = async (config: string) => {
  const context = await createTestServer(testDb());
  await context.api.repos.register({ runnerId: context.runnerId, path: repoPath });
  context.files[".halinka/config.yml"] = config;
  return context;
};

const createUntrusted = async ({ services }: Awaited<ReturnType<typeof withConfig>>) =>
  services.run.createFrom(1, await services.repo.readWorkflow(1, "build"), {
    isUntrusted: true,
  });

const syncWorktreeRunner = ({ plane }: Awaited<ReturnType<typeof withConfig>>) =>
  plane.sync({ held: [], capacity: 1, capabilities: worktreeRunner });

describe("POST /api/runs", () => {
  const withRepo = async () => {
    const context = await createTestServer(testDb());
    await context.api.repos.register({ runnerId: context.runnerId, path: repoPath });
    return context;
  };

  it("queues a run of a workflow by name", async () => {
    const { api } = await withRepo();
    expect(await api.runs.create({ repoId: 1, workflow: "build" })).toEqual({
      id: 1,
      status: "queued",
    });
    expect(await testDb().select().from(workflowRuns)).toHaveLength(1);
  });

  it("wakes the runner at a new run", async () => {
    const { commands, api } = await withRepo();

    await api.runs.create({ repoId: 1, workflow: "build" });

    expect(commands.wake).toHaveBeenCalled();
  });

  it("accepts a path in .halinka/workflows/", async () => {
    const { api } = await withRepo();

    expect(
      await api.runs.create({ repoId: 1, workflow: ".halinka/workflows/build.yml" }),
    ).toMatchObject({ status: "queued" });
  });

  it("finds a .yaml workflow by name", async () => {
    const { api, files } = await withRepo();
    files[".halinka/workflows/fix.yaml"] =
      "schema_version: 1\nname: Fix\nsteps:\n  - id: fix\n    type: shell\n    run: ls\n";

    await api.runs.create({ repoId: 1, workflow: "fix" });

    expect((await api.runs.list({})).runs.map((run) => run.workflowPath)).toEqual([
      ".halinka/workflows/fix.yaml",
    ]);
  });

  const fixWorkflow = [
    "schema_version: 1",
    "name: Fix",
    "inputs:",
    "  issue: { type: number, required: true }",
    "  draft: { type: boolean, default: false }",
    "steps:",
    "  - id: fix",
    "    type: shell",
    "    run: ls",
  ].join("\n");

  it("queues a run with its resolved inputs, which the claim gives", async () => {
    const { files, api, claimOne } = await createConnectedTestServer(testDb());
    files[".halinka/workflows/fix.yml"] = fixWorkflow;

    await api.runs.create({ repoId: 1, workflow: "fix", inputs: { issue: "12" } });

    expect((await claimOne()).inputs).toEqual({ issue: 12, draft: false });
  });

  it("answers 400 with an issue at each refused input", async () => {
    const { files, api } = await withRepo();
    files[".halinka/workflows/fix.yml"] = fixWorkflow;

    const error = await api.runs
      .create({ repoId: 1, workflow: "fix", inputs: { issue: 12, title: "Fix" } })
      .catch((e) => e);

    expect(isDefinedError(error)).toBe(true);
    expect(error).toMatchObject({
      code: "BAD_REQUEST",
      message: "Check the inputs",
      data: {
        issues: [{ path: ["inputs", "title"], message: "The workflow has no such input" }],
      },
    });
  });

  it("queues nothing for a refused input", async () => {
    const { files, api } = await withRepo();
    files[".halinka/workflows/fix.yml"] = fixWorkflow;

    await api.runs
      .create({ repoId: 1, workflow: "fix", inputs: { issue: 12, title: "Fix" } })
      .catch(() => {});

    expect(await testDb().select().from(workflowRuns)).toHaveLength(0);
  });

  const withBranchWorkflow = async () => {
    const context = await withRepo();
    context.files[".halinka/workflows/fix.yml"] = [
      "schema_version: 1",
      "name: Fix",
      "inputs:",
      "  issue: { required: true }",
      "branch:",
      "  name: halinka/issue-${{ inputs.issue }}",
      "steps:",
      "  - id: fix",
      "    type: shell",
      "    run: ls",
    ].join("\n");
    const create = (issue: string) =>
      context.api.runs.create({ repoId: 1, workflow: "fix", inputs: { issue } });
    return { ...context, create };
  };

  it("queues a run on the branch from its inputs", async () => {
    const { create } = await withBranchWorkflow();

    await create("12");

    expect(await testDb().select().from(workflowRuns)).toMatchObject([
      { branchName: "halinka/issue-12", branch: "halinka/issue-12", createdBranch: false },
    ]);
  });

  it("answers 409 with the active run that has the branch", async () => {
    const { create } = await withBranchWorkflow();
    await create("12");

    await expect(create("12")).rejects.toMatchObject({
      code: "CONFLICT",
      message: "The run 1 uses the branch halinka/issue-12. Wait until it ends, or cancel it.",
    });
  });

  it("queues a run on the branch of a run that ended", async () => {
    const { api, create } = await withBranchWorkflow();
    await create("12");
    await api.runs.cancel({ id: 1 });

    expect(await create("12")).toMatchObject({ status: "queued" });
  });

  it("answers 409 when an active run has the default branch of the new run", async () => {
    const { api, files } = await withRepo();
    files[".halinka/workflows/fix.yml"] =
      "schema_version: 1\nname: Fix\nbranch: { name: halinka/run-2 }\nsteps:\n  - { id: fix, type: shell, run: ls }\n";
    await api.runs.create({ repoId: 1, workflow: "fix" });

    await expect(api.runs.create({ repoId: 1, workflow: "build" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "An active run uses the branch of this run. Wait until it ends, or cancel it.",
    });
  });

  it("answers 400 for a branch name that the inputs make invalid", async () => {
    const { create } = await withBranchWorkflow();

    await expect(create("a b")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/^The branch name "halinka\/issue-a b" is not valid\./),
    });
  });

  it("refuses a path that is not a workflow path", async () => {
    const { api } = await withRepo();

    await expect(
      api.runs.create({ repoId: 1, workflow: ".halinka/config.yml" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Use a workflow name, a file name or a path in .halinka/workflows/",
    });
  });

  it("answers 404 for an unknown repo or workflow", async () => {
    const { api } = await withRepo();
    await expect(api.runs.create({ repoId: 2, workflow: "build" })).rejects.toMatchObject({
      status: 404,
    });
    await expect(api.runs.create({ repoId: 1, workflow: "deploy" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
      message: "There is no workflow deploy",
    });
  });

  it("answers 400 with the problems of an invalid workflow", async () => {
    const { files, api } = await withRepo();
    files[".halinka/workflows/build.yml"] = "schema_version: 1\nname: Build\nsteps: []\n";
    const error = await api.runs.create({ repoId: 1, workflow: "build" }).catch((e) => e);
    expect(isDefinedError(error)).toBe(true);
    expect(error).toMatchObject({
      code: "INVALID_WORKFLOW",
      status: 400,
      message: ".halinka/workflows/build.yml is not a valid workflow",
      data: {
        path: ".halinka/workflows/build.yml",
        problems: [{ line: 3, column: 1, path: ["steps"], message: "Add at least one step" }],
      },
    });
  });

  it("queues nothing for an invalid workflow", async () => {
    const { files, api } = await withRepo();
    files[".halinka/workflows/build.yml"] = "schema_version: 1\nname: Build\nsteps: []\n";

    await api.runs.create({ repoId: 1, workflow: "build" }).catch(() => {});

    expect(await testDb().select().from(workflowRuns)).toHaveLength(0);
  });

  it("refuses a run when the repo's runner is revoked", async () => {
    const { api, runnerId } = await withRepo();
    await api.runners.revoke({ id: runnerId });

    await expect(api.runs.create({ repoId: 1, workflow: "build" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "The runner local is revoked",
    });
  });

  it("refuses a run that the repo's runner cannot take with its labels", async () => {
    const { files, api } = await withRepo();
    files[".halinka/workflows/gpu.yml"] = gpuWorkflow;

    await expect(api.runs.create({ repoId: 1, workflow: "gpu" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "The runner local has no label gpu. Add the label to the runner, or change runs-on",
    });
  });

  it("stores no snapshot of a run that the repo's runner refuses", async () => {
    const { api, runnerId } = await withRepo();
    await api.runners.revoke({ id: runnerId });

    await api.runs.create({ repoId: 1, workflow: "build" }).catch(() => {});

    expect(await testDb().select().from(workflowSnapshots)).toHaveLength(0);
  });

  it("refuses a run with an agent that the repo's runner does not allow", async () => {
    const { files, api, runnerId } = await withRepo();
    files[".halinka/workflows/implement.yml"] = implementWorkflow;
    await api.runners.update({ id: runnerId, allowedAgents: ["codex"] });

    await expect(api.runs.create({ repoId: 1, workflow: "implement" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "The runner local does not allow the agent claude-code",
    });
  });

  it("refuses a run with a missing label when the repo's runner drains", async () => {
    const { files, api, runnerId } = await withRepo();
    files[".halinka/workflows/gpu.yml"] = gpuWorkflow;
    await api.runners.update({ id: runnerId, state: "draining" });

    await expect(api.runs.create({ repoId: 1, workflow: "gpu" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "The runner local has no label gpu. Add the label to the runner, or change runs-on",
    });
  });

  it("queues a run when the repo's runner drains", async () => {
    const { api, runnerId } = await withRepo();
    await api.runners.update({ id: runnerId, state: "draining" });

    expect(await api.runs.create({ repoId: 1, workflow: "build" })).toMatchObject({
      status: "queued",
    });
  });

  it("queues a run when the repo's runner waits for its update", async () => {
    const { api, runnerId } = await withRepo();
    await testDb()
      .update(runners)
      .set({ canUpdate: true, updateRequest: "when_idle" })
      .where(eq(runners.id, runnerId));

    expect(await api.runs.create({ repoId: 1, workflow: "build" })).toMatchObject({
      status: "queued",
    });
  });

  it("queues a run that no process of the repo's runner can take yet", async () => {
    const { api, plane } = await withRepo();
    await plane.sync({ held: [], capacity: 0, capabilities: devcontainerRunner });

    expect(await api.runs.create({ repoId: 1, workflow: "build" })).toMatchObject({
      status: "queued",
    });
  });

  const snapshot = async () => (await testDb().select().from(workflowSnapshots))[0];

  it("keeps the devcontainer path and its text from the base commit in the snapshot", async () => {
    const { api, baseCommitFiles, commands } = await withConfig(devcontainerConfig);
    baseCommitFiles[".devcontainer/devcontainer.json"] = '{ "image": "node" }';

    await api.runs.create({ repoId: 1, workflow: "build" });

    expect(await snapshot()).toMatchObject({
      devcontainer: ".devcontainer/devcontainer.json",
      files: { ".devcontainer/devcontainer.json": '{ "image": "node" }' },
    });
    expect(commands.readCommitFile).toHaveBeenCalledWith({
      repoPath,
      commit: baseSha,
      path: ".devcontainer/devcontainer.json",
    });
  });

  it("gives the setup network of the repo config to the claim", async () => {
    const { api, plane } = await withConfig(
      `${devcontainerConfig}setup:\n  network: [registry.npmjs.org]\n`,
    );
    await api.runs.create({ repoId: 1, workflow: "build" });

    const { claimed } = await plane.sync({
      held: [],
      capacity: 1,
      capabilities: devcontainerRunner,
    });

    expect(claimed[0]?.setupNetwork).toEqual(["registry.npmjs.org"]);
  });

  it("gives the setup network of the repo config to the sandbox target", async () => {
    const { api, plane } = await withConfig(
      `${devcontainerConfig}setup:\n  network: [registry.npmjs.org]\n`,
    );
    await api.runs.create({ repoId: 1, workflow: "build" });
    const capabilities = devcontainerRunner;
    const { claimed } = await plane.sync({ held: [], capacity: 1, capabilities });
    const [run] = claimed;
    await plane.finishRun(run!.lease, "succeeded");

    const { sandboxes } = await plane.sync({ held: [], capacity: 0, capabilities });

    expect(sandboxes[0]?.setupNetwork).toEqual(["registry.npmjs.org"]);
  });

  const docker = `${devcontainerConfig}setup:\n  docker: true\n`;

  it("gives a runner without Sysbox no run that asks for Docker", async () => {
    const { api, plane } = await withConfig(docker);
    await api.runs.create({ repoId: 1, workflow: "build" });

    const { claimed } = await plane.sync({
      held: [],
      capacity: 1,
      capabilities: devcontainerRunner,
    });

    expect(claimed).toEqual([]);
  });

  it("says why a runner without Sysbox gets no run that asks for Docker", async () => {
    const { api, plane } = await withConfig(docker);
    await api.runs.create({ repoId: 1, workflow: "build" });

    await plane.sync({ held: [], capacity: 1, capabilities: devcontainerRunner });

    expect((await api.runs.get({ id: 1 })).waitReason).toBe(
      "The repo asks for Docker in the container, and the runner local has no Sysbox. Start the runner with --docker-in-container on a Linux host with Sysbox",
    );
  });

  it("gives a runner with Sysbox the run that asks for Docker", async () => {
    const { api, plane } = await withConfig(docker);
    await api.runs.create({ repoId: 1, workflow: "build" });

    const { claimed } = await plane.sync({
      held: [],
      capacity: 1,
      capabilities: { ...devcontainerRunner, hasSysbox: true },
    });

    expect(claimed[0]?.setupDocker).toBe(true);
  });

  it("gives the Docker request of the repo config to the sandbox target", async () => {
    const { api, plane } = await withConfig(docker);
    await api.runs.create({ repoId: 1, workflow: "build" });
    const capabilities = { ...devcontainerRunner, hasSysbox: true };
    const { claimed } = await plane.sync({ held: [], capacity: 1, capabilities });
    await plane.finishRun(claimed[0]!.lease, "succeeded");

    const { sandboxes } = await plane.sync({ held: [], capacity: 0, capabilities });

    expect(sandboxes[0]?.setupDocker).toBe(true);
  });

  const value = "npm_made_up_value";
  const named = `${devcontainerConfig}setup:\n  run: npm ci\n  secrets: [NPM_TOKEN]\n`;
  const run = `${devcontainerConfig}setup:\n  run: npm ci\n`;

  it("gives the claim the command of setup", async () => {
    const { api, plane } = await withConfig(run);
    await api.runs.create({ repoId: 1, workflow: "build" });

    const { claimed } = await plane.sync({
      held: [],
      capacity: 1,
      capabilities: devcontainerRunner,
    });

    expect(claimed[0]?.setupRun).toBe("npm ci");
  });

  it("refuses a run that names a secret the repo does not have", async () => {
    const { api } = await withConfig(named);

    await expect(api.runs.create({ repoId: 1, workflow: "build" })).rejects.toThrow(
      "The repo has no secret NPM_TOKEN",
    );
  });

  it("refuses a run that names a secret of another repo", async () => {
    const { api, runnerId } = await withConfig(named);
    const other = { name: "other", path: "/code/other", runnerId };
    await createRepositories(testDb()).repo.register(other);
    await api.repos.setSecret({ id: 2, name: "NPM_TOKEN", value });

    await expect(api.runs.create({ repoId: 1, workflow: "build" })).rejects.toThrow(
      "The repo has no secret NPM_TOKEN",
    );
  });

  it("gives a worktree runner no run that names a secret", async () => {
    const { api, plane } = await withConfig(named);
    await api.repos.setSecret({ id: 1, name: "NPM_TOKEN", value });
    await api.runs.create({ repoId: 1, workflow: "build" });

    const { claimed } = await plane.sync({
      held: [],
      capacity: 1,
      capabilities: worktreeRunner,
    });

    expect(claimed).toEqual([]);
  });

  it("says why a worktree runner gets no run that names a secret", async () => {
    const { api, plane } = await withConfig(named);
    await api.repos.setSecret({ id: 1, name: "NPM_TOKEN", value });
    await api.runs.create({ repoId: 1, workflow: "build" });

    await plane.sync({ held: [], capacity: 1, capabilities: worktreeRunner });

    expect((await api.runs.get({ id: 1 })).waitReason).toBe(
      "The runner local runs workflows in a worktree, and only a container gets the secrets of setup",
    );
  });

  it("gives a worktree runner a run whose setup names no secret", async () => {
    const { api, plane } = await withConfig(run);
    await api.runs.create({ repoId: 1, workflow: "build" });

    const { claimed } = await plane.sync({
      held: [],
      capacity: 1,
      capabilities: worktreeRunner,
    });

    expect(claimed).toHaveLength(1);
  });

  it("gives setup no network when the repo config names none", async () => {
    const { api } = await withConfig(devcontainerConfig);

    await api.runs.create({ repoId: 1, workflow: "build" });

    expect((await snapshot())?.setupNetwork).toEqual([]);
  });

  it("keeps the path of a devcontainer that the base commit does not have", async () => {
    const { api } = await withConfig(
      "schema_version: 1\nserver: local\ndevcontainer: .devcontainer/new.json\n",
    );

    await api.runs.create({ repoId: 1, workflow: "build" });

    const stored = await snapshot();
    expect(stored?.devcontainer).toBe(".devcontainer/new.json");
    expect(Object.keys(stored?.files ?? {}).sort()).toEqual([
      ".halinka/config.yml",
      ".halinka/workflows/build.yml",
    ]);
  });

  it("refuses a config that is not valid", async () => {
    const { api } = await withConfig(
      "schema_version: 1\nserver: local\ndevcontainer: ../outside.json\n",
    );

    await expect(api.runs.create({ repoId: 1, workflow: "build" })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining(".halinka/config.yml is not valid: line 3"),
    });
  });

  it("gives the devcontainer path to the runner that claims the run", async () => {
    const { api, files, claimOne } = await createConnectedTestServer(testDb());
    files[".halinka/config.yml"] = devcontainerConfig;
    await api.runs.create({ repoId: 1, workflow: "build" });

    expect((await claimOne([], "devcontainer")).devcontainer).toBe(
      ".devcontainer/devcontainer.json",
    );
  });

  it("marks the run as no test run", async () => {
    const { api } = await withRepo();

    const { id } = await api.runs.create({ repoId: 1, workflow: "build" });

    expect(await api.runs.get({ id })).toMatchObject({ isTestRun: false });
  });
});

describe("sync", () => {
  it("gives an untrusted run to no worktree runner", async () => {
    const context = await withConfig(devcontainerConfig);
    await createUntrusted(context);

    const { claimed } = await syncWorktreeRunner(context);

    expect(claimed).toEqual([]);
  });

  it("gives an untrusted run to a devcontainer runner with the flag", async () => {
    const context = await withConfig(devcontainerConfig);
    await createUntrusted(context);

    const { claimed } = await context.plane.sync({
      held: [],
      capacity: 1,
      capabilities: devcontainerRunner,
    });

    expect(claimed[0]).toMatchObject({ sandboxKind: "devcontainer", isUntrusted: true });
  });
});

describe("GET /api/runs", () => {
  it("lists the runs newest first", async () => {
    const { api, queue } = await createConnectedTestServer(testDb());
    await queue();
    await queue();

    const { runs } = await api.runs.list({});

    expect(runs.map(({ id }) => id)).toEqual([2, 1]);
  });

  it("names the workflow of each run", async () => {
    const { api, queue } = await createConnectedTestServer(testDb());
    await queue();

    expect((await api.runs.list({})).runs).toMatchObject([
      { workflowPath: ".halinka/workflows/build.yml", workflowName: "Build" },
    ]);
  });

  it("names the repo of each run", async () => {
    const { api, runnerId, queue } = await createConnectedTestServer(testDb());
    await api.repos.register({ runnerId, path: secondRepoPath });
    await api.runs.create({ repoId: 2, workflow: "build" });
    await queue();

    const { runs } = await api.runs.list({});

    expect(runs.map(({ repoName }) => repoName)).toEqual(["app", "web"]);
  });

  it("lists only the runs of the repo", async () => {
    const { api, queue } = await createConnectedTestServer(testDb());
    await queue();

    expect((await api.runs.list({ repoId: 1 })).runs).toHaveLength(1);
    expect((await api.runs.list({ repoId: 2 })).runs).toEqual([]);
  });

  it("gives the next page after the last run of a page", async () => {
    const { api, queue } = await createConnectedTestServer(testDb());
    await queue();
    await queue();
    await queue();

    const first = await api.runs.list({ limit: 2 });
    const second = await api.runs.list({ limit: 2, beforeId: first.nextBeforeId });

    expect(first).toMatchObject({ runs: [{ id: 3 }, { id: 2 }], nextBeforeId: 2 });
    expect(second.runs.map(({ id }) => id)).toEqual([1]);
  });

  it("gives no next page when the last page is full", async () => {
    const { api, queue } = await createConnectedTestServer(testDb());
    await queue();
    await queue();

    expect((await api.runs.list({ limit: 2 })).nextBeforeId).toBeUndefined();
  });

  it.each([0, 201])("refuses the limit %i", async (limit) => {
    const { api } = await createConnectedTestServer(testDb());

    await expect(api.runs.list({ limit })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("lists only the active runs", async () => {
    const { api, queue } = await createConnectedTestServer(testDb());
    await queue();
    await queue();
    await api.runs.cancel({ id: 1 });

    expect((await api.runs.list({ state: "active" })).runs.map(({ id }) => id)).toEqual([2]);
  });

  it("lists only the ended runs", async () => {
    const { api, queue } = await createConnectedTestServer(testDb());
    await queue();
    await queue();
    await api.runs.cancel({ id: 1 });

    expect((await api.runs.list({ state: "ended" })).runs.map(({ id }) => id)).toEqual([1]);
  });
});

describe("GET /api/runs/totals", () => {
  it("counts the runs of the period by result", async () => {
    const { api, queue, claimOne, plane } = await createConnectedTestServer(testDb());
    await queue();
    await plane.finishRun((await claimOne()).lease, "succeeded");
    await queue();
    await plane.finishRun((await claimOne()).lease, "failed");
    await queue();

    expect(await api.runs.totals()).toMatchObject({ days: 30, runs: 3, succeeded: 1, failed: 1 });
  });

  it("gives one entry per UTC day of the period, oldest first", async () => {
    const { api } = await createConnectedTestServer(testDb());

    const days = (await api.runs.totals()).perDay.map(({ day }) => day);

    expect(days).toHaveLength(30);
    expect(days).toEqual(days.toSorted());
  });

  it("counts a run on the UTC day it was created", async () => {
    const { api, queue, claimOne, plane } = await createConnectedTestServer(testDb());
    await queue();
    await plane.finishRun((await claimOne()).lease, "failed");
    const [run] = await testDb()
      .update(workflowRuns)
      .set({ createdAt: sql`now() - make_interval(days => 2)` })
      .returning({ createdAt: workflowRuns.createdAt });
    const day = run!.createdAt.toISOString().slice(0, 10);

    const { perDay } = await api.runs.totals();

    expect(perDay.find((entry) => entry.day === day)).toEqual({
      day,
      succeeded: 0,
      failed: 1,
      other: 0,
    });
  });

  it("leaves out the runs before the first day of the period", async () => {
    const { api, queue } = await createConnectedTestServer(testDb());
    await queue();
    await testDb()
      .update(workflowRuns)
      .set({ createdAt: sql`now() - make_interval(days => 30)` });

    expect((await api.runs.totals()).runs).toBe(0);
  });
});

describe("GET /api/runs/{id}/events", () => {
  it("gives the events after a seq, in order", async () => {
    const { api, plane, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue();
    const { lease } = await claimOne();
    await plane.appendEvents(lease, {
      batchId: "b1",
      events: [agentPrompt("a"), agentPrompt("b"), agentPrompt("c")],
    });

    const events = await api.runs.events({ id: 1, after: 1 });

    expect(events).toMatchObject([
      { seq: 2, event: agentPrompt("b") },
      { seq: 3, event: agentPrompt("c") },
    ]);
  });

  it("gives only the events of the run", async () => {
    const { api, plane, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue();
    await queue();
    const first = await claimOne();
    const second = await claimOne([first.lease]);
    await plane.appendEvents(first.lease, { batchId: "b1", events: [agentPrompt("a")] });
    await plane.appendEvents(second.lease, { batchId: "b2", events: [agentPrompt("b")] });

    const events = await api.runs.events({ id: 2 });

    expect(events).toMatchObject([{ seq: 2, event: agentPrompt("b") }]);
  });

  it("answers 404 for an unknown run", async () => {
    const { api } = await createTestServer(testDb());

    await expect(api.runs.events({ id: 1 })).rejects.toMatchObject({ status: 404 });
  });
});

describe("GET /api/runs/{id}/stream", () => {
  const watcher =
    ({ api }: Awaited<ReturnType<typeof createConnectedTestServer>>) =>
    async (input: { id?: number; after?: number } = {}, lastEventId?: string) => {
      const stream = await api.runs.watch({ id: 1, ...input }, { lastEventId });
      onTestFinished(async () => {
        await stream.return(undefined);
      });
      await stream.next();
      return stream;
    };

  const setUp = async (options: { bus?: RunBus } = {}) => {
    const context = await createConnectedTestServer(testDb(), options);
    await context.queue();
    const append = (lease: RunLease, ...texts: string[]) =>
      context.plane.appendEvents(lease, { batchId: texts.join(), events: texts.map(agentPrompt) });
    return { ...context, watch: watcher(context), append };
  };

  const withAgentStep = async () => {
    const context = await createConnectedTestServer(testDb());
    return { ...context, ...(await context.startAgentStep()), watch: watcher(context) };
  };

  it("says first that the state changed, so a reconnecting client reads the run again", async () => {
    const { api } = await setUp();

    const stream = await api.runs.watch({ id: 1 });
    onTestFinished(async () => {
      await stream.return(undefined);
    });

    expect((await stream.next()).value).toEqual({ type: "state" });
  });

  it("gives the stored events after the state", async () => {
    const { claimOne, watch, append } = await setUp();
    await append((await claimOne()).lease, "a");

    const stream = await watch();

    expect((await stream.next()).value).toMatchObject({
      type: "events",
      events: [{ seq: 1, event: agentPrompt("a") }],
    });
  });

  it("gives each new batch after the stored events", async () => {
    const { claimOne, watch, append } = await setUp();
    const { lease } = await claimOne();
    await append(lease, "a");
    const stream = await watch();
    await stream.next();

    await append(lease, "b");

    expect((await stream.next()).value).toMatchObject({
      events: [{ seq: 2, event: agentPrompt("b") }],
    });
  });

  it("marks a batch with its last seq as the event id", async () => {
    const { claimOne, watch, append } = await setUp();
    await append((await claimOne()).lease, "a", "b");

    const stream = await watch();

    expect(getEventMeta((await stream.next()).value)).toMatchObject({ id: "2" });
  });

  it("continues after the after seq", async () => {
    const { claimOne, watch, append } = await setUp();
    await append((await claimOne()).lease, "a", "b");

    const stream = await watch({ after: 1 });

    expect((await stream.next()).value).toMatchObject({ events: [{ seq: 2 }] });
  });

  it("continues after the last event id of a reconnect", async () => {
    const { claimOne, watch, append } = await setUp();
    await append((await claimOne()).lease, "a", "b");

    const stream = await watch({}, "1");

    expect((await stream.next()).value).toMatchObject({ events: [{ seq: 2 }] });
  });

  it("continues after the after seq when the last event id is not a number", async () => {
    const { claimOne, watch, append } = await setUp();
    await append((await claimOne()).lease, "a", "b");

    const stream = await watch({ after: 1 }, "x");

    expect((await stream.next()).value).toMatchObject({ events: [{ seq: 2 }] });
  });

  it("says that the state changed when the runner claims the run", async () => {
    const { claimOne, watch } = await setUp();
    const next = (await watch()).next();

    await claimOne();

    expect((await next).value).toEqual({ type: "state" });
  });

  it("says that the state changed when the runner starts a step", async () => {
    const { plane, claimOne, watch } = await setUp();
    const { lease } = await claimOne();
    const next = (await watch()).next();

    await plane.startStep(lease, "build");

    expect((await next).value).toEqual({ type: "state" });
  });

  it("says that the state changed when the runner gives the run back", async () => {
    const { plane, claimOne, watch } = await setUp();
    await claimOne();
    const next = (await watch()).next();

    await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });

    expect((await next).value).toEqual({ type: "state" });
  });

  it("says that the state changed when the run is cancelled", async () => {
    const { api, watch } = await setUp();
    const next = (await watch()).next();

    await api.runs.cancel({ id: 1 });

    expect((await next).value).toEqual({ type: "state" });
  });

  it("says that the state changed when a message is sent", async () => {
    const { api, stepRunId, watch } = await withAgentStep();
    const next = (await watch()).next();

    await api.runs.sendMessage({ id: 1, stepRunId, text: "Use SQLite" });

    expect((await next).value).toEqual({ type: "state" });
  });

  it("says that the state changed when a prompt delivers a message", async () => {
    const { api, plane, claimed, stepRunId, attemptId, watch } = await withAgentStep();
    const { id: messageId } = await api.runs.sendMessage({ id: 1, stepRunId, text: "Use SQLite" });
    const stream = await watch();

    await plane.appendEvents(claimed.lease, {
      batchId: "b1",
      events: [deliveringPrompt(attemptId, messageId)],
    });

    const changes = [(await stream.next()).value, (await stream.next()).value];
    expect(changes).toContainEqual({ type: "state" });
  });

  it("gives only the changes of its run", async () => {
    const { plane, queue, claimOne, watch, append } = await setUp();
    await queue();
    const first = await claimOne();
    const second = await claimOne([first.lease]);
    const next = (await watch({ id: 1 })).next();

    await plane.startStep(second.lease, "build");
    await append(first.lease, "a");

    expect((await next).value).toMatchObject({ type: "events" });
  });

  it("stops listening when the client ends the stream", async () => {
    const bus = new CountingBus();
    const { watch } = await setUp({ bus });
    const stream = await watch();

    await stream.return(undefined);

    await vi.waitFor(() => expect(bus.openSubscriptions()).toBe(0));
  });

  it("answers 404 for an unknown run", async () => {
    const { api } = await createTestServer(testDb());

    await expect(api.runs.watch({ id: 1 })).rejects.toMatchObject({ status: 404 });
  });
});

type ConnectedServer = Awaited<ReturnType<typeof createConnectedTestServer>>;

type FinishStepOptions = { stepId: string; after: string };

const finishStep = async (
  { plane }: ConnectedServer,
  lease: RunLease,
  { stepId, after }: FinishStepOptions,
) => {
  const stepRunId = await plane.startStep(lease, stepId);
  const { attemptId } = await plane.startAttempt(lease, stepRunId);
  const checkpoint = testCheckpoint(baseSha, after);
  const succeeded = { status: "succeeded", summary: "Done" } as const;
  await plane.finishAttempt(lease, attemptId, {
    result: { status: "succeeded", checkpoint },
    stepResult: succeeded,
  });
};

// Claims the queued run, gives its `build` step the checkpoint `after`, and ends it with `result`.
const finishBuild = async (
  server: ConnectedServer,
  after: string,
  result: "succeeded" | "failed" = "succeeded",
) => {
  const { lease } = await server.claimOne();
  await finishStep(server, lease, { stepId: "build", after });
  await server.plane.finishRun(lease, result);
};

const finishedWithCheckpoint = async (result: "succeeded" | "failed" = "succeeded") => {
  const server = await createConnectedTestServer(testDb());
  await server.queue();
  await finishBuild(server, "c1", result);
  return server;
};

const attach = { containerName: "loving_borg", containerFolder: "/workspaces/run-1" };

const withStartedContainer = async (options?: { isRemoteRunner?: boolean }) => {
  const context = await createConnectedTestServer(testDb(), options);
  await context.finishOne("devcontainer");
  await context.api.runs.setSandbox({ id: 1, spec: "running" });
  await context.plane.reportSandbox({
    workflowRunId: 1,
    generation: 3,
    observed: "running",
    attach,
  });
  return context;
};

const shipWorkflow = [
  "schema_version: 1",
  "name: Ship",
  "branch: { name: halinka/ship }",
  "steps:",
  "  - id: rounds",
  "    type: loop",
  "    max_iterations: 3",
  "    until: ${{ steps.review.outcome == 'approve' }}",
  "    steps:",
  "      - id: implement",
  "        type: agent",
  "        agent: claude-code",
  "        prompt: Fix",
  "      - id: review",
  "        type: agent",
  "        agent: claude-code",
  "        prompt: Review",
  "        permissions: { write: false }",
  "        outcomes: [approve, changes]",
  "  - id: publish",
  "    type: shell",
  "    run: ls",
].join("\n");

// The loop runs, `implement` succeeded in iteration 1, and `review` runs.
// `message`: a message to `implement` that its prompt delivered
const withFinishedStep = async ({ checkpoint = true, message = false } = {}) => {
  const server = await createConnectedTestServer(testDb());
  const { files, api, plane, claimOne } = server;
  files[".halinka/workflows/ship.yml"] = shipWorkflow;
  await api.runs.create({ repoId: 1, workflow: "ship" });
  const { lease } = await claimOne();
  const rounds = await plane.startStep(lease, "rounds");
  const parent = { stepRunId: rounds, iteration: 1 };
  const implement = await plane.startStep(lease, "implement", parent);
  const { attemptId } = await plane.startAttempt(lease, implement);
  if (message) {
    await api.runs.sendMessage({ id: 1, stepRunId: implement, text: "Use Postgres" });
    await plane.appendEvents(lease, { batchId: "b0", events: [deliveringPrompt(attemptId, 1)] });
  }
  const fixed = { status: "succeeded", summary: "Fixed" } as const;
  const result = {
    ...fixed,
    ...(checkpoint && { checkpoint: testCheckpoint("c0", "c1") }),
    sessionId: "s1",
    sessionCostUsd: 2,
    usage: { activeMs: 10, costUsd: 2 },
  };
  await plane.finishAttempt(lease, attemptId, { result, stepResult: fixed });
  const review = await plane.startStep(lease, "review", parent);
  const reopen = () => api.runs.sendMessage({ id: 1, stepRunId: implement, text: "Use SQLite" });
  return { ...server, lease, rounds, implement, review, reopen };
};

const finishPublish = async (status: "failed" | "succeeded") => {
  const server = await createConnectedTestServer(testDb());
  server.files[".halinka/workflows/publish.yml"] = publishWorkflow;
  await server.api.runs.create({ repoId: 1, workflow: "publish" });
  const { lease } = await server.claimOne();
  await finishStep(server, lease, { stepId: "build", after: "c1" });
  const publish = await server.plane.startStep(lease, "publish");
  const { attemptId } = await server.plane.startAttempt(lease, publish);
  await server.plane.finishAttempt(lease, attemptId, {
    result: { status },
    stepResult: { status },
  });
  await server.plane.finishRun(lease, status);
  return { ...server, publish };
};

describe("GET /api/runs/{id}", () => {
  it("gives no wait reason when the runner can take the run", async () => {
    const { api, plane, queue } = await createConnectedTestServer(testDb());
    await queue();
    await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });

    expect((await api.runs.get({ id: 1 })).waitReason).toBeUndefined();
  });

  it("tells in the wait reason that the runner drains", async () => {
    const { api, runnerId, queue } = await createConnectedTestServer(testDb());
    await queue();
    await api.runners.update({ id: runnerId, state: "draining" });

    expect((await api.runs.get({ id: 1 })).waitReason).toBe(
      "The runner local drains: it takes no new runs",
    );
  });

  it("tells in the wait reason that the runner waits for its update", async () => {
    const { api, runnerId, queue } = await createConnectedTestServer(testDb());
    await queue();
    await testDb()
      .update(runners)
      .set({ canUpdate: true, updateRequest: "when_idle" })
      .where(eq(runners.id, runnerId));

    expect((await api.runs.get({ id: 1 })).waitReason).toBe(
      "The runner local waits for its update: it takes no new runs until it starts again",
    );
  });

  it("gives no wait reason for a run that is not queued", async () => {
    const { api, runnerId, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue();
    await claimOne();
    await api.runners.update({ id: runnerId, state: "draining" });

    expect((await api.runs.get({ id: 1 })).waitReason).toBeUndefined();
  });

  it("tells the settings refusal in the wait reason before the runner is not connected", async () => {
    const { api, runnerId, disconnect, queue } = await createConnectedTestServer(testDb());
    await queue();
    await api.runners.update({ id: runnerId, state: "draining" });
    disconnect();

    expect((await api.runs.get({ id: 1 })).waitReason).toBe(
      "The runner local drains: it takes no new runs",
    );
  });

  it("tells in the wait reason that a runner that never synced is not connected", async () => {
    const { api, disconnect, queue } = await createConnectedTestServer(testDb());
    await queue();
    disconnect();

    expect((await api.runs.get({ id: 1 })).waitReason).toBe("The runner local is not connected");
  });

  it("tells in the wait reason that the runner is not connected before a capability refusal", async () => {
    const { api, plane, disconnect, queue } = await createConnectedTestServer(testDb());
    await queue();
    await plane.sync({ held: [], capacity: 0, capabilities: devcontainerRunner });
    disconnect();

    expect((await api.runs.get({ id: 1 })).waitReason).toBe("The runner local is not connected");
  });

  it("tells in the wait reason that the run keeps a workspace of the other sandbox kind", async () => {
    const { api, plane, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue("devcontainer");
    await claimOne([], "devcontainer");
    await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });

    expect((await api.runs.get({ id: 1 })).waitReason).toBe(
      "The run keeps a workspace in a devcontainer, and the runner local runs workflows in a worktree. Remove the workspace of the run",
    );
  });

  it("tells in the wait reason that Docker is not available", async () => {
    const { api, plane, queue } = await createConnectedTestServer(testDb());
    await queue("devcontainer");
    const noDocker: RunnerCapabilities = { ...devcontainerRunner, hasDocker: false };
    await plane.sync({ held: [], capacity: 0, capabilities: noDocker });

    expect((await api.runs.get({ id: 1 })).waitReason).toBe(
      "Docker is not available on the runner local",
    );
  });

  it("tells in the wait reason that a devcontainer runner gets a repo without a devcontainer", async () => {
    const { api, plane, queue } = await createConnectedTestServer(testDb());
    await queue();
    await plane.sync({ held: [], capacity: 0, capabilities: devcontainerRunner });

    expect((await api.runs.get({ id: 1 })).waitReason).toBe(
      "The runner local runs workflows in a devcontainer, and the repo has no devcontainer in .halinka/config.yml",
    );
  });

  it("tells in the wait reason which agent is not on the PATH of a worktree runner", async () => {
    const { api, plane, files } = await createConnectedTestServer(testDb());
    files[".halinka/workflows/implement.yml"] = implementWorkflow;
    await api.runs.create({ repoId: 1, workflow: "implement" });
    const onlyCodex: RunnerCapabilities = { ...worktreeRunner, agentsOnPath: ["codex"] };
    await plane.sync({ held: [], capacity: 0, capabilities: onlyCodex });

    expect((await api.runs.get({ id: 1 })).waitReason).toBe(
      "The runner local has no command of the agent claude-code on PATH",
    );
  });

  it("tells in the wait reason that an untrusted run needs a container", async () => {
    const context = await withConfig(devcontainerConfig);
    const { id } = await createUntrusted(context);

    await syncWorktreeRunner(context);

    expect((await context.api.runs.get({ id })).waitReason).toBe(
      "The run comes from GitHub or a schedule, and the runner local runs workflows in a worktree. The run needs a container",
    );
  });

  it("gives the results of the step runs and the checkpoints of the attempts, without the report", async () => {
    const { api, plane, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue();
    const { lease } = await claimOne();
    const stepRunId = await plane.startStep(lease, "build");
    const { attemptId } = await plane.startAttempt(lease, stepRunId);
    const checkpoint = { before: baseSha, after: "c1", changedFiles: ["a.ts"] };
    await plane.finishAttempt(lease, attemptId, {
      result: { status: "succeeded", checkpoint },
      stepResult: { status: "succeeded", summary: "Done", outcome: "approved" },
    });

    const { stepRuns, attempts } = await api.runs.get({ id: 1 });

    expect(stepRuns).toMatchObject([{ summary: "Done", outcome: "approved" }]);
    expect(stepRuns[0]).not.toHaveProperty("outputs");
    expect(attempts).toMatchObject([{ commitBefore: baseSha, commitAfter: "c1" }]);
    expect(attempts[0]).not.toHaveProperty("summary");
  });

  it("gives the run with its step runs and attempts", async () => {
    const { api, plane, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue();
    const { lease } = await claimOne();
    const stepRunId = await plane.startStep(lease, "build");
    const { attemptId } = await plane.startAttempt(lease, stepRunId);
    await plane.finishAttempt(lease, attemptId, { result: { status: "failed", exitCode: 2 } });
    await plane.startAttempt(lease, stepRunId);

    const run = await api.runs.get({ id: 1 });

    expect(run).toMatchObject({
      id: 1,
      status: "running",
      repoName: "app",
      branch: "halinka/run-1",
      workflow: { name: "Build", steps: [{ id: "build", type: "shell", run: "ls" }] },
      stepRuns: [{ id: stepRunId, stepId: "build", status: "running" }],
      attempts: [
        { stepRunId, attempt: 1, status: "failed", exitCode: 2 },
        { stepRunId, attempt: 2, status: "running" },
      ],
    });
    expect(run.stepRuns[0]).not.toHaveProperty("finishedAt");
    expect(run.attempts[1]).not.toHaveProperty("exitCode");
    expect(run.attempts[1]).not.toHaveProperty("finishedAt");
  });

  it("gives the undelivered messages of the run", async () => {
    const { api, startAgentStep } = await createConnectedTestServer(testDb());
    const { stepRunId } = await startAgentStep();
    await api.runs.sendMessage({ id: 1, stepRunId, text: "Use SQLite" });

    const { undeliveredMessages } = await api.runs.get({ id: 1 });

    expect(undeliveredMessages).toEqual([
      {
        id: 1,
        stepRunId,
        text: "Use SQLite",
        author: "local",
        createdAt: expect.any(String),
      },
    ]);
  });

  it("leaves out a message that a prompt delivered", async () => {
    const { api, plane, startAgentStep } = await createConnectedTestServer(testDb());
    const { claimed, stepRunId, attemptId } = await startAgentStep();
    const { id: messageId } = await api.runs.sendMessage({ id: 1, stepRunId, text: "Use SQLite" });
    await plane.appendEvents(claimed.lease, {
      batchId: "b1",
      events: [deliveringPrompt(attemptId, messageId)],
    });

    const { undeliveredMessages } = await api.runs.get({ id: 1 });

    expect(undeliveredMessages).toEqual([]);
  });

  it("gives the running agent step run as the message target", async () => {
    const { api, startAgentStep } = await createConnectedTestServer(testDb());
    const { stepRunId } = await startAgentStep();

    const { messageTarget } = await api.runs.get({ id: 1 });

    expect(messageTarget).toEqual({ stepRunId });
  });

  it("gives no message target while the running step is not an agent step", async () => {
    const { api, plane, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue();
    const claimed = await claimOne();
    await plane.startStep(claimed.lease, "build");

    expect((await api.runs.get({ id: 1 })).messageTarget).toBeUndefined();
  });

  it("gives no message target for a run with a cancel request", async () => {
    const { api, startAgentStep } = await createConnectedTestServer(testDb());
    await startAgentStep();
    await api.runs.cancel({ id: 1 });

    expect((await api.runs.get({ id: 1 })).messageTarget).toBeUndefined();
  });

  it("gives the decision that a message gives a pending limit item of the step", async () => {
    const { api, plane, startAgentStep } = await createConnectedTestServer(testDb());
    const { claimed, stepRunId, attemptId } = await startAgentStep();
    await plane.askHuman(claimed.lease, attemptId, {
      result: { status: "stopped" },
      kind: "limit",
      message: "The agent reached max_turns.",
    });

    const { messageTarget } = await api.runs.get({ id: 1 });

    expect(messageTarget).toEqual({ stepRunId, decision: "continue" });
  });

  it("gives no decision when the item of the step is resolved", async () => {
    const { api, plane, startAgentStep } = await createConnectedTestServer(testDb());
    const { claimed, stepRunId, attemptId } = await startAgentStep();
    const itemId = await plane.askHuman(claimed.lease, attemptId, {
      result: { status: "stopped" },
      kind: "limit",
      message: "The agent reached max_turns.",
    });
    await api.inbox.resolve({ id: itemId, decision: "continue", note: null });

    const { messageTarget } = await api.runs.get({ id: 1 });

    expect(messageTarget).toEqual({ stepRunId });
  });

  it("says that a running run can be cancelled until a cancel is requested", async () => {
    const { api, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue();
    await claimOne();
    const before = await api.runs.get({ id: 1 });

    await api.runs.cancel({ id: 1 });

    expect(before.canCancel).toBe(true);
    expect((await api.runs.get({ id: 1 })).canCancel).toBe(false);
  });

  it("says that a waiting run can be cancelled until a cancel is requested", async () => {
    const { api, waitForApproval } = await createConnectedTestServer(testDb());
    await waitForApproval();
    const before = await api.runs.get({ id: 1 });

    await api.runs.cancel({ id: 1 });

    expect(before.canCancel).toBe(true);
    expect((await api.runs.get({ id: 1 })).canCancel).toBe(false);
  });

  it("says that an ended run cannot be cancelled", async () => {
    const { api, queue } = await createConnectedTestServer(testDb());
    await queue();
    await api.runs.cancel({ id: 1 });

    expect((await api.runs.get({ id: 1 })).canCancel).toBe(false);
  });

  it("gives only the inbox items of the run, decided ones too, with their step", async () => {
    const { api, waitForApproval } = await createConnectedTestServer(testDb());
    const first = await waitForApproval();
    await waitForApproval([first.claimed.lease]);
    await api.inbox.resolve({ id: first.itemId, decision: "reject", note: "Add a test" });

    const { inboxItems } = await api.runs.get({ id: first.claimed.lease.workflowRunId });

    expect(inboxItems).toMatchObject([
      { id: first.itemId, stepId: "approve", decision: "reject", note: "Add a test" },
    ]);
  });

  it("adds the implicit outputs of an agent step to its reported outputs", async () => {
    const { api, plane, files, claimOne } = await createConnectedTestServer(testDb());
    files[".halinka/workflows/review.yml"] = [
      "schema_version: 1",
      "name: Review",
      "steps:",
      "  - id: review",
      "    type: agent",
      "    agent: claude-code",
      "    permissions: { write: false }",
      "    prompt: Review",
      "    outputs: { findings: string }",
    ].join("\n");
    await api.runs.create({ repoId: 1, workflow: "review" });
    const { lease } = await claimOne();
    const reviewId = await plane.startStep(lease, "review");
    const { attemptId } = await plane.startAttempt(lease, reviewId);
    const checkpoint = { before: baseSha, after: "c1", changedFiles: ["a.ts"] };
    await plane.finishAttempt(lease, attemptId, {
      result: {
        status: "succeeded",
        checkpoint,
        sessionId: "s1",
        usage: { activeMs: 1000, costUsd: 0.5 },
      },
      stepResult: { status: "succeeded", outputs: { findings: "none" } },
    });

    const { stepRuns } = await api.runs.get({ id: 1 });

    expect(stepRuns[0]?.outputs).toEqual({
      findings: "none",
      changed_files: ["a.ts"],
      changed_file_count: 1,
      commit: "c1",
      session_id: "s1",
      cost_usd: 0.5,
      reviewed_commit: "c1",
    });
  });

  it("gives a step run the cost of its attempts", async () => {
    const { api, plane, startAgentStep } = await createConnectedTestServer(testDb());
    const { claimed, attemptId } = await startAgentStep();
    const status = "succeeded" as const;
    const usage = { activeMs: 1, costUsd: 0.5 };
    await plane.finishAttempt(claimed.lease, attemptId, {
      result: { status, usage },
      stepResult: { status },
    });

    const { stepRuns } = await api.runs.get({ id: 1 });

    expect(stepRuns[0]?.usage).toEqual({ costUsd: 0.5 });
  });

  it("gives no cost to a step run whose attempts report none", async () => {
    const { api, plane, startAgentStep } = await createConnectedTestServer(testDb());
    const { claimed, attemptId } = await startAgentStep();
    const status = "succeeded" as const;
    const usage = { activeMs: 1 };
    await plane.finishAttempt(claimed.lease, attemptId, {
      result: { status, usage },
      stepResult: { status },
    });

    const { stepRuns } = await api.runs.get({ id: 1 });

    expect(stepRuns[0]?.usage).toBeUndefined();
  });

  it("gives the loop step run and the iteration of a loop child", async () => {
    const { api, plane, files, claimOne } = await createConnectedTestServer(testDb());
    files[".halinka/workflows/fix.yml"] = [
      "schema_version: 1",
      "name: Fix",
      "steps:",
      "  - id: fix_loop",
      "    type: loop",
      "    max_iterations: 2",
      "    until: ${{ steps.check.status == 'succeeded' }}",
      "    steps:",
      "      - id: check",
      "        type: shell",
      "        run: ls",
    ].join("\n");
    await api.runs.create({ repoId: 1, workflow: "fix" });
    const { lease } = await claimOne();
    const loopId = await plane.startStep(lease, "fix_loop");
    await plane.startStep(lease, "check", { stepRunId: loopId, iteration: 1 });

    const { stepRuns } = await api.runs.get({ id: 1 });

    expect(stepRuns).toMatchObject([
      { stepId: "fix_loop" },
      { stepId: "check", parentStepRunId: loopId, iteration: 1 },
    ]);
    expect(stepRuns[0]).not.toHaveProperty("parentStepRunId");
  });

  it("lists only the step runs and attempts of the run", async () => {
    const { api, plane, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue();
    await queue();
    const first = await claimOne();
    const second = await claimOne([first.lease]);
    for (const { lease } of [first, second]) {
      await plane.startAttempt(lease, await plane.startStep(lease, "build"));
    }

    const run = await api.runs.get({ id: 2 });

    expect(run.stepRuns.map(({ id }) => id)).toEqual([2]);
    expect(run.attempts.map(({ stepRunId }) => stepRunId)).toEqual([2]);
  });

  it("gives a pending sandbox of a finished run until the runner reports it", async () => {
    const { api, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();

    const { sandbox } = await api.runs.get({ id: 1 });

    expect(sandbox).toEqual({
      kind: "worktree",
      spec: "stopped",
      isInUse: false,
      isPending: true,
    });
  });

  it("gives the observed state of the sandbox after the report", async () => {
    const { api, plane, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();

    await plane.reportSandbox({ workflowRunId: 1, generation: 2, observed: "stopped" });

    expect((await api.runs.get({ id: 1 })).sandbox).toMatchObject({
      observed: "stopped",
      isPending: false,
    });
  });

  it("gives the running container of a finished run on the runner of this machine", async () => {
    const { api } = await withStartedContainer();

    expect((await api.runs.get({ id: 1 })).sandbox?.attach).toEqual(attach);
  });

  it("gives no container of a runner of another machine", async () => {
    const { api } = await withStartedContainer({ isRemoteRunner: true });

    expect((await api.runs.get({ id: 1 })).sandbox?.attach).toBeUndefined();
  });

  it("gives the folder of the container of a runner of another machine", async () => {
    const { api } = await withStartedContainer({ isRemoteRunner: true });

    expect((await api.runs.get({ id: 1 })).sandbox?.sshFolder).toBe(attach.containerFolder);
  });

  it("gives no folder of the container of the runner of this machine", async () => {
    const { api } = await withStartedContainer();

    expect((await api.runs.get({ id: 1 })).sandbox?.sshFolder).toBeUndefined();
  });

  it("gives no container while the runner has not applied the spec", async () => {
    const { api } = await withStartedContainer();

    await api.runs.setSandbox({ id: 1, spec: "stopped" });

    expect((await api.runs.get({ id: 1 })).sandbox?.attach).toBeUndefined();
  });

  it("takes a new container that the runner reports for the same spec", async () => {
    const { api, plane } = await withStartedContainer();

    await plane.reportSandbox({
      workflowRunId: 1,
      generation: 3,
      observed: "running",
      attach: { ...attach, containerName: "eager_curie" },
    });

    expect((await api.runs.get({ id: 1 })).sandbox?.attach).toMatchObject({
      containerName: "eager_curie",
    });
  });

  it("drops the container when a later report of the running sandbox has none", async () => {
    const { api, plane } = await withStartedContainer();

    await plane.reportSandbox({ workflowRunId: 1, generation: 3, observed: "running" });

    expect((await api.runs.get({ id: 1 })).sandbox?.attach).toBeUndefined();
  });

  it("gives the sandbox of a leased run in use, not pending", async () => {
    const { api, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue();
    await claimOne();

    expect((await api.runs.get({ id: 1 })).sandbox).toMatchObject({
      isInUse: true,
      isPending: false,
    });
  });

  it("gives no sandbox error of an earlier check for a run in use", async () => {
    const { api, plane, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue();
    await claimOne();
    await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });
    await plane.reportSandbox({ workflowRunId: 1, generation: 1, error: "Disk full" });

    await claimOne();
    const { sandbox } = await api.runs.get({ id: 1 });

    expect({ isInUse: sandbox?.isInUse, error: sandbox?.error }).toEqual({ isInUse: true });
  });

  it("drops the sandbox error of the last spec when the spec changes", async () => {
    const { api, plane, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();
    await plane.reportSandbox({ workflowRunId: 1, generation: 2, error: "Disk full" });

    await api.runs.removeSandbox({ id: 1 });

    expect((await api.runs.get({ id: 1 })).sandbox?.error).toBeUndefined();
  });

  it("lets a person remove the sandbox of a finished run", async () => {
    const { api, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();

    expect((await api.runs.get({ id: 1 })).canRemoveSandbox).toBe(true);
  });

  it("does not let a person remove the sandbox of an active run", async () => {
    const { api, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue();
    await claimOne();

    expect((await api.runs.get({ id: 1 })).canRemoveSandbox).toBe(false);
  });

  it("does not let a person remove the sandbox of a run that never had one", async () => {
    const { api, queue } = await createConnectedTestServer(testDb());
    await queue();
    await api.runs.cancel({ id: 1 });

    expect((await api.runs.get({ id: 1 })).canRemoveSandbox).toBe(false);
  });

  it("does not let a person remove a removed sandbox again", async () => {
    const { api, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();
    await api.runs.removeSandbox({ id: 1 });

    expect((await api.runs.get({ id: 1 })).canRemoveSandbox).toBe(false);
  });

  it("does not let a person delete an active run", async () => {
    const { api, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue();
    await claimOne();

    expect((await api.runs.get({ id: 1 })).canDelete).toBe(false);
  });

  it("lets a person start the container of a finished run, and not stop it", async () => {
    const { api, finishOne } = await createConnectedTestServer(testDb());
    await finishOne("devcontainer");

    expect(await api.runs.get({ id: 1 })).toMatchObject({
      canStartSandbox: true,
      canStopSandbox: false,
    });
  });

  it("offers a push only for a run that ended", async () => {
    const { api, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue();
    await claimOne();

    expect((await api.runs.get({ id: 1 })).canPush).toBe(false);
  });

  it("offers a pull request for a run that succeeded", async () => {
    const { api } = await finishedWithCheckpoint();

    expect((await api.runs.get({ id: 1 })).canOpenPullRequest).toBe(true);
  });

  it("offers no pull request for a run that failed", async () => {
    const { api } = await finishedWithCheckpoint("failed");

    expect((await api.runs.get({ id: 1 })).canOpenPullRequest).toBe(false);
  });

  it("offers a retry of a failed github step", async () => {
    const { api, publish } = await finishPublish("failed");

    expect((await api.runs.get({ id: 1 })).retryTargets).toEqual([publish]);
  });

  it("offers no retry of a github step that succeeded", async () => {
    const { api } = await finishPublish("succeeded");

    expect((await api.runs.get({ id: 1 })).retryTargets).toEqual([]);
  });

  it("offers no retry of a github step that failed before an attempt", async () => {
    const server = await createConnectedTestServer(testDb());
    server.files[".halinka/workflows/publish.yml"] = publishWorkflow;
    await server.api.runs.create({ repoId: 1, workflow: "publish" });
    const { lease } = await server.claimOne();
    const publish = await server.plane.startStep(lease, "publish");
    await server.plane.finishStep(lease, publish, { status: "failed" });
    await server.plane.finishRun(lease, "failed");

    expect((await server.api.runs.get({ id: 1 })).retryTargets).toEqual([]);
  });

  it("gives the finished agent step runs as reopen targets", async () => {
    const { api, implement } = await withFinishedStep();

    expect((await api.runs.get({ id: 1 })).reopenTargets).toEqual([implement]);
  });

  it("gives no reopen targets for a run with a cancel request", async () => {
    const { api } = await withFinishedStep();
    await api.runs.cancel({ id: 1 });

    expect((await api.runs.get({ id: 1 })).reopenTargets).toEqual([]);
  });

  it("answers 404 for an unknown run", async () => {
    const { api } = await createTestServer(testDb());

    await expect(api.runs.get({ id: 1 })).rejects.toMatchObject({ status: 404 });
  });
});

describe("POST /api/runs/{id}/cancel", () => {
  const withQueuedRun = async () => {
    const context = await createConnectedTestServer(testDb());
    await context.queue();
    vi.mocked(context.commands.wake).mockClear();
    const cancel = () => context.api.runs.cancel({ id: 1 });
    return { ...context, cancel };
  };

  it("cancels a queued run at once", async () => {
    const { cancel, plane } = await withQueuedRun();

    const run = await cancel();

    expect(run).toEqual({ id: 1, status: "cancelled" });
    expect(
      (await plane.sync({ held: [], capacity: 1, capabilities: worktreeRunner })).claimed,
    ).toEqual([]);
  });

  it("asks the runner to stop a running run, which stays running until then", async () => {
    const { cancel, plane, claimOne, commands } = await withQueuedRun();
    const claimed = await claimOne();

    expect(await cancel()).toEqual({ id: 1, status: "running" });

    expect(commands.wake).toHaveBeenCalled();
    expect(
      await plane.sync({ held: [claimed.lease], capacity: 0, capabilities: worktreeRunner }),
    ).toEqual({
      keep: [],
      claimed: [],
      answers: [],
      messages: [],
      sandboxes: [],
    });
  });

  it("asks the runner to stop a run that waits for input", async () => {
    const { api, plane, commands, waitForApproval } = await createConnectedTestServer(testDb());
    const { claimed } = await waitForApproval();
    vi.mocked(commands.wake).mockClear();

    expect(await api.runs.cancel({ id: 1 })).toEqual({ id: 1, status: "waiting_input" });

    expect(commands.wake).toHaveBeenCalled();
    const { keep } = await plane.sync({
      held: [claimed.lease],
      capacity: 0,
      capabilities: worktreeRunner,
    });
    expect(keep).toEqual([]);
  });

  it("leaves a finished run as it is", async () => {
    const { cancel, plane, claimOne } = await withQueuedRun();
    await plane.finishRun((await claimOne()).lease, "succeeded");

    expect(await cancel()).toEqual({ id: 1, status: "succeeded" });
  });

  it("closes the running step of a requeued run as cancelled", async () => {
    const { cancel, plane, claimOne } = await withQueuedRun();
    const { lease } = await claimOne();
    const stepRunId = await plane.startStep(lease, "build");
    await plane.startAttempt(lease, stepRunId);
    await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });

    await cancel();

    expect(await testDb().select().from(stepRuns)).toMatchObject([{ status: "cancelled" }]);
  });

  it("answers 404 for an unknown run", async () => {
    const { api } = await withQueuedRun();

    await expect(api.runs.cancel({ id: 2 })).rejects.toMatchObject({ status: 404 });
  });
});

describe("DELETE /api/runs/{id}/sandbox", () => {
  const withFinishedRun = async () => {
    const context = await createConnectedTestServer(testDb());
    await context.finishOne();
    vi.mocked(context.commands.wake).mockClear();
    return context;
  };

  it("wants the sandbox of a finished run removed", async () => {
    const { api, plane } = await withFinishedRun();

    await api.runs.removeSandbox({ id: 1 });

    const { sandboxes } = await plane.sync({
      held: [],
      capacity: 0,
      capabilities: worktreeRunner,
    });
    expect(sandboxes).toMatchObject([{ workflowRunId: 1, spec: "destroyed", generation: 3 }]);
  });

  it("wakes the runner", async () => {
    const { api, commands } = await withFinishedRun();

    await api.runs.removeSandbox({ id: 1 });

    expect(commands.wake).toHaveBeenCalled();
  });

  it("signals a state change of the run", async () => {
    const { api, bus } = await withFinishedRun();
    const changes: string[] = [];
    bus.subscribe(1, (change) => changes.push(change));

    await api.runs.removeSandbox({ id: 1 });

    expect(changes).toEqual(["state"]);
  });

  it("changes nothing when the sandbox is already removed", async () => {
    const { api, plane, commands } = await withFinishedRun();
    await api.runs.removeSandbox({ id: 1 });
    vi.mocked(commands.wake).mockClear();

    await api.runs.removeSandbox({ id: 1 });

    const { sandboxes } = await plane.sync({
      held: [],
      capacity: 0,
      capabilities: worktreeRunner,
    });
    expect(sandboxes).toMatchObject([{ generation: 3 }]);
    expect(commands.wake).not.toHaveBeenCalled();
  });

  it("refuses an active run", async () => {
    const { api, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue();
    await claimOne();

    await expect(api.runs.removeSandbox({ id: 1 })).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a run that never had a sandbox", async () => {
    const { api, queue } = await createConnectedTestServer(testDb());
    await queue();
    await api.runs.cancel({ id: 1 });

    await expect(api.runs.removeSandbox({ id: 1 })).rejects.toMatchObject({ status: 409 });
  });

  it("answers 404 for an unknown run", async () => {
    const { api } = await createConnectedTestServer(testDb());

    await expect(api.runs.removeSandbox({ id: 1 })).rejects.toMatchObject({ status: 404 });
  });
});

describe("DELETE /api/runs/{id}", () => {
  const removedReport = { workflowRunId: 1, generation: 3, observed: "absent" } as const;

  it("deletes a run that never had a sandbox at once", async () => {
    const { api, queue } = await createConnectedTestServer(testDb());
    await queue();
    await api.runs.cancel({ id: 1 });

    expect(await api.runs.delete({ id: 1 })).toEqual({ id: 1, isDeleted: true });
    expect(await testDb().select().from(workflowRuns)).toEqual([]);
  });

  it("hides a run that the runner still has a sandbox of", async () => {
    const { api, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();

    expect(await api.runs.delete({ id: 1 })).toEqual({ id: 1, isDeleted: false });

    await expect(api.runs.get({ id: 1 })).rejects.toMatchObject({ status: 404 });
    expect((await api.runs.list({})).runs).toEqual([]);
  });

  it("wants the sandbox of a deleting run removed", async () => {
    const { api, plane, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();

    await api.runs.delete({ id: 1 });

    const { sandboxes } = await plane.sync({
      held: [],
      capacity: 0,
      capabilities: worktreeRunner,
    });
    expect(sandboxes).toMatchObject([{ workflowRunId: 1, spec: "destroyed", generation: 3 }]);
  });

  it("deletes a run whose sandbox is removed at once", async () => {
    const { api, plane, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();
    await api.runs.removeSandbox({ id: 1 });
    await plane.reportSandbox(removedReport);

    expect(await api.runs.delete({ id: 1 })).toEqual({ id: 1, isDeleted: true });
  });

  it("removes the row when the runner reports the sandbox removed", async () => {
    const { api, plane, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();
    await api.runs.delete({ id: 1 });

    await plane.reportSandbox(removedReport);

    expect(await testDb().select().from(workflowRuns)).toEqual([]);
  });

  it("refuses an active run", async () => {
    const { api, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue();
    await claimOne();

    await expect(api.runs.delete({ id: 1 })).rejects.toMatchObject({ status: 409 });
  });

  it("refuses to delete a run that is being deleted", async () => {
    const { api, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();
    await api.runs.delete({ id: 1 });

    await expect(api.runs.delete({ id: 1 })).rejects.toMatchObject({ status: 404 });
  });

  it("deletes a run of a revoked runner at once", async () => {
    const { api, runnerId, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();
    await api.runners.revoke({ id: runnerId });

    expect(await api.runs.delete({ id: 1 })).toEqual({ id: 1, isDeleted: true });
  });

  it("removes the deleting runs of a runner that an Admin revokes", async () => {
    const { api, runnerId, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();
    await api.runs.delete({ id: 1 });

    await api.runners.revoke({ id: runnerId });

    expect(await testDb().select().from(workflowRuns)).toEqual([]);
  });
});

describe("PUT /api/runs/{id}/sandbox", () => {
  const withFinishedContainer = async () => {
    const context = await createConnectedTestServer(testDb());
    await context.finishOne("devcontainer");
    vi.mocked(context.commands.wake).mockClear();
    return context;
  };

  it("wants the container of a finished run started", async () => {
    const { api, plane } = await withFinishedContainer();

    await api.runs.setSandbox({ id: 1, spec: "running" });

    const { sandboxes } = await plane.sync({
      held: [],
      capacity: 0,
      capabilities: worktreeRunner,
    });
    expect(sandboxes).toMatchObject([{ workflowRunId: 1, spec: "running", generation: 3 }]);
  });

  it("wakes the runner when a person starts a container", async () => {
    const { api, commands } = await withFinishedContainer();

    await api.runs.setSandbox({ id: 1, spec: "running" });

    expect(commands.wake).toHaveBeenCalled();
  });

  it("wants a started container stopped again", async () => {
    const { api, plane } = await withFinishedContainer();
    await api.runs.setSandbox({ id: 1, spec: "running" });

    await api.runs.setSandbox({ id: 1, spec: "stopped" });

    const { sandboxes } = await plane.sync({
      held: [],
      capacity: 0,
      capabilities: worktreeRunner,
    });
    expect(sandboxes).toMatchObject([{ spec: "stopped", generation: 4 }]);
  });

  it("refuses a container in the wanted state", async () => {
    const { api } = await withFinishedContainer();

    await expect(api.runs.setSandbox({ id: 1, spec: "stopped" })).rejects.toMatchObject({
      status: 409,
      message: "The container of run 1 is already stopped",
    });
  });

  it("refuses a run that works in a worktree", async () => {
    const { api, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();

    await expect(api.runs.setSandbox({ id: 1, spec: "running" })).rejects.toMatchObject({
      status: 409,
      message: "Run 1 works in a worktree, which has no container",
    });
  });

  it("refuses to start a removed container", async () => {
    const { api } = await withFinishedContainer();
    await api.runs.removeSandbox({ id: 1 });

    await expect(api.runs.setSandbox({ id: 1, spec: "running" })).rejects.toMatchObject({
      status: 409,
      message: "The workspace of run 1 is removed. Reopen a step to make it again.",
    });
  });

  it("refuses an active run", async () => {
    const { api, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue("devcontainer");
    await claimOne([], "devcontainer");

    await expect(api.runs.setSandbox({ id: 1, spec: "stopped" })).rejects.toMatchObject({
      status: 409,
      message: "Run 1 is active. Cancel it first.",
    });
  });
});

describe("GET /api/runs/{id}/ssh-host-key", () => {
  it("gives the SSH key of the runner of a run", async () => {
    const { api, runnerId } = await withStartedContainer();

    expect(await api.runs.sshHostKey({ id: 1 })).toEqual({
      runnerId,
      sshHostKey: testSshHostKey,
    });
  });

  it("gives no SSH key of a runner in a worktree", async () => {
    const { api, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();

    await expect(api.runs.sshHostKey({ id: 1 })).rejects.toThrow("has no SSH key");
  });

  it("gives no SSH key for a run that does not exist", async () => {
    const { api } = await withStartedContainer();

    await expect(api.runs.sshHostKey({ id: 99 })).rejects.toThrow("There is no run 99");
  });
});

describe("openRelay", () => {
  it("opens a relay to the running container of a finished run", async () => {
    const { services, runnerId } = await withStartedContainer();

    expect(await services.run.openRelay(1)).toBe(runnerId);
  });

  it("marks the workspace as opened at a relay", async () => {
    const { services } = await withStartedContainer();

    await services.run.openRelay(1);

    const [run] = await testDb().select().from(workflowRuns);
    expect(run?.workspaceOpened).toBe(true);
  });

  it("keeps the container for 24 h more at a relay", async () => {
    const { services } = await withStartedContainer();
    await testDb()
      .update(workflowRuns)
      .set({ sandboxKeptAt: new Date(0) });

    await services.run.openRelay(1);

    const [run] = await testDb().select().from(workflowRuns);
    expect(run?.sandboxKeptAt?.getTime()).toBeGreaterThan(0);
  });

  it("refuses a relay to a run that does not exist", async () => {
    const { services } = await createConnectedTestServer(testDb());

    await expect(services.run.openRelay(99)).rejects.toThrow("There is no run 99");
  });

  it("refuses a relay to a run that holds a lease", async () => {
    const { services, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue("devcontainer");
    await claimOne([], "devcontainer");

    await expect(services.run.openRelay(1)).rejects.toThrow("Run 1 is active");
  });

  it("refuses a relay to a run in a worktree", async () => {
    const { services, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();

    await expect(services.run.openRelay(1)).rejects.toThrow("works in a worktree");
  });

  it("refuses a relay while the runner has not applied the spec", async () => {
    const { services, api, plane } = await withStartedContainer();
    await api.runs.setSandbox({ id: 1, spec: "stopped" });
    await plane.reportSandbox({ workflowRunId: 1, generation: 4, observed: "running" });
    await api.runs.setSandbox({ id: 1, spec: "running" });

    await expect(services.run.openRelay(1)).rejects.toThrow("does not run");
  });

  it("refuses a relay to a stopped container", async () => {
    const { services, api } = await withStartedContainer();

    await api.runs.setSandbox({ id: 1, spec: "stopped" });

    await expect(services.run.openRelay(1)).rejects.toThrow("does not run");
  });
});

describe("relayRefusal", () => {
  it("gives no refusal to an open relay of a running container", async () => {
    const { services } = await withStartedContainer();

    expect(await services.run.relayRefusal(1)).toBeUndefined();
  });

  it("gives a refusal to an open relay when the container stops", async () => {
    const { services, api } = await withStartedContainer();

    await api.runs.setSandbox({ id: 1, spec: "stopped" });

    expect(await services.run.relayRefusal(1)).toMatchObject({
      message: expect.stringContaining("does not run"),
    });
  });

  it("gives a refusal to an open relay of a run that does not exist", async () => {
    const { services } = await withStartedContainer();

    expect(await services.run.relayRefusal(99)).toMatchObject({ message: "There is no run 99" });
  });
});

describe("POST /api/runs/{id}/steps/{stepRunId}/messages", () => {
  const withAgentStep = async () => {
    const server = await createConnectedTestServer(testDb());
    return { ...server, ...(await server.startAgentStep()) };
  };

  const withPendingItem = async (kind: AttemptItemKind = "ask_human") => {
    const step = await withAgentStep();
    const { plane, claimed, attemptId } = step;
    const itemId = await plane.askHuman(claimed.lease, attemptId, {
      result: { status: "failed" },
      kind,
      message: "Decide.",
    });
    return { ...step, itemId };
  };

  it("stores a message to a running agent step", async () => {
    const { api, stepRunId } = await withAgentStep();

    expect(await api.runs.sendMessage({ id: 1, stepRunId, text: " Use SQLite " })).toEqual({
      id: 1,
      stepRunId,
      text: "Use SQLite",
      author: "local",
      createdAt: expect.any(String),
    });
  });

  it("wakes the runner", async () => {
    const { api, commands, stepRunId } = await withAgentStep();
    vi.mocked(commands.wake).mockClear();

    await api.runs.sendMessage({ id: 1, stepRunId, text: "Use SQLite" });

    expect(commands.wake).toHaveBeenCalled();
  });

  it("refuses a message to a step that is not an agent step", async () => {
    const { api, plane, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue();
    const claimed = await claimOne();
    const stepRunId = await plane.startStep(claimed.lease, "build");

    await expect(
      api.runs.sendMessage({ id: 1, stepRunId, text: "Use SQLite" }),
    ).rejects.toMatchObject({ status: 400, message: "The step build is not an agent step" });
  });

  it.each([
    ["ask_human", "retry"],
    ["limit", "continue"],
  ] as const)("resolves a pending %s item of the step with %s", async (kind, decision) => {
    const { api, stepRunId, itemId } = await withPendingItem(kind);

    await api.runs.sendMessage({ id: 1, stepRunId, text: "Use SQLite" });

    expect((await api.runs.get({ id: 1 })).inboxItems).toMatchObject([
      { id: itemId, kind, decision, resolvedBy: "local" },
    ]);
  });

  it("wakes the runner when it resolves an item", async () => {
    const { api, commands, stepRunId } = await withPendingItem();
    vi.mocked(commands.wake).mockClear();

    await api.runs.sendMessage({ id: 1, stepRunId, text: "Use SQLite" });

    expect(commands.wake).toHaveBeenCalled();
  });

  it("stores the message when it resolves an item", async () => {
    const { api, stepRunId } = await withPendingItem();

    await api.runs.sendMessage({ id: 1, stepRunId, text: "Use SQLite" });

    expect(await testDb().select().from(agentMessages)).toMatchObject([
      { stepRunId, text: "Use SQLite", deliveredAt: null },
    ]);
  });

  it("sets the run to running when it resolves an item", async () => {
    const { api, stepRunId } = await withPendingItem();

    await api.runs.sendMessage({ id: 1, stepRunId, text: "Use SQLite" });

    expect(await api.runs.get({ id: 1 })).toMatchObject({ status: "running" });
  });

  it("accepts a message while a question of the step waits for an answer", async () => {
    const { api, plane, claimed, stepRunId, attemptId } = await withAgentStep();
    await plane.askQuestion(claimed.lease, attemptId, testQuestions);

    expect(await api.runs.sendMessage({ id: 1, stepRunId, text: "Use SQLite" })).toMatchObject({
      text: "Use SQLite",
    });
  });

  it("refuses a message to a run that its runner gave back", async () => {
    const { api, plane, stepRunId } = await withAgentStep();
    await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });

    await expect(
      api.runs.sendMessage({ id: 1, stepRunId, text: "Use SQLite" }),
    ).rejects.toMatchObject({ status: 409, message: "Run 1 is not running" });
  });

  it("refuses a message to a run with a cancel request", async () => {
    const { api, stepRunId } = await withAgentStep();
    await api.runs.cancel({ id: 1 });

    await expect(
      api.runs.sendMessage({ id: 1, stepRunId, text: "Use SQLite" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses an empty message", async () => {
    const { api, stepRunId } = await withAgentStep();

    await expect(api.runs.sendMessage({ id: 1, stepRunId, text: "  " })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("answers 404 for an unknown run", async () => {
    const { api, stepRunId } = await withAgentStep();

    await expect(
      api.runs.sendMessage({ id: 2, stepRunId, text: "Use SQLite" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  const statusesOf = async (api: Awaited<ReturnType<typeof withFinishedStep>>["api"]) =>
    (await api.runs.get({ id: 1 })).stepRuns.map(({ id, stepId, status }) => ({
      id,
      stepId,
      status,
    }));

  it("supersedes a finished step run and the step runs after it, and starts the step again", async () => {
    const { api, rounds, implement, review, reopen } = await withFinishedStep();

    const message = await reopen();

    expect(await statusesOf(api)).toEqual([
      { id: rounds, stepId: "rounds", status: "running" },
      { id: implement, stepId: "implement", status: "superseded" },
      { id: review, stepId: "review", status: "superseded" },
      { id: message.stepRunId, stepId: "implement", status: "running" },
    ]);
  });

  it("starts a finished step again in the iteration of its step run", async () => {
    const { api, rounds, reopen } = await withFinishedStep();

    const { stepRunId } = await reopen();

    expect(
      (await api.runs.get({ id: 1 })).stepRuns.find(({ id }) => id === stepRunId),
    ).toMatchObject({ parentStepRunId: rounds, iteration: 1 });
  });

  it("sets a finished loop of the step back to running, without its result", async () => {
    const { api, plane, lease, rounds, review, reopen } = await withFinishedStep();
    await plane.finishStep(lease, review, { status: "succeeded", outcome: "approve" });
    await plane.finishStep(lease, rounds, { status: "succeeded", summary: "Done" });

    await reopen();

    const [stepRun] = (await api.runs.get({ id: 1 })).stepRuns;

    expect(stepRun?.status).toBe("running");
    expect(stepRun).not.toHaveProperty("summary");
    expect(stepRun).not.toHaveProperty("finishedAt");
  });

  it("queues a live run again at a reopen", async () => {
    const { api, reopen } = await withFinishedStep();

    await reopen();

    expect(await api.runs.get({ id: 1 })).toMatchObject({ status: "queued" });
  });

  it("gives back the lease of a live run at a reopen, so the old engine cannot write", async () => {
    const { plane, lease, review, reopen } = await withFinishedStep();

    await reopen();

    await expect(plane.startAttempt(lease, review)).rejects.toMatchObject({ code: "lease_lost" });
  });

  it("marks the running attempts of the superseded step runs lost", async () => {
    const { api, plane, lease, review, reopen } = await withFinishedStep();
    await plane.startAttempt(lease, review);

    await reopen();

    const { attempts } = await api.runs.get({ id: 1 });
    expect(attempts.find(({ stepRunId }) => stepRunId === review)).toMatchObject({
      status: "lost",
    });
  });

  it("closes the pending items of the superseded step runs", async () => {
    const { api, plane, lease, review, reopen } = await withFinishedStep();
    const { attemptId } = await plane.startAttempt(lease, review);
    await plane.askQuestion(lease, attemptId, testQuestions);

    await reopen();

    expect((await api.runs.get({ id: 1 })).inboxItems).toMatchObject([
      { stepRunId: review, resolvedBy: "halinka", resolvedAt: expect.any(String) },
    ]);
  });

  it("claims the reopen with the commits of the rewind and the replaced step run", async () => {
    const { claimOne, rounds, reopen } = await withFinishedStep();
    const { stepRunId } = await reopen();

    const claimed = await claimOne();

    expect(claimed).toMatchObject({
      lastCheckpoint: "c0",
      rewind: { stepRunId, before: "c0", after: "c1", isFresh: true, hasLaterAttempts: false },
      steps: [
        { stepRunId: rounds, status: "running" },
        {
          stepRunId,
          stepId: "implement",
          status: "running",
          reopened: {
            summary: "Fixed",
            changedFiles: ["a.ts"],
            sessionId: "s1",
            sessionCostUsd: 2,
          },
        },
      ],
    });
  });

  it("keeps the base of the rewind after a lost first attempt of the reopen", async () => {
    const { plane, claimOne, reopen } = await withFinishedStep();
    const { stepRunId } = await reopen();
    await plane.startAttempt((await claimOne()).lease, stepRunId);
    await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });

    const claimed = await claimOne();

    expect(claimed).toMatchObject({ lastCheckpoint: "c0", rewind: { isFresh: false } });
  });

  it("claims without a rewind after the reopen has a checkpoint", async () => {
    const { plane, claimOne, reopen } = await withFinishedStep();
    const { stepRunId } = await reopen();
    const { lease } = await claimOne();
    const { attemptId } = await plane.startAttempt(lease, stepRunId);
    await plane.finishAttempt(lease, attemptId, {
      result: {
        status: "failed",
        checkpoint: testCheckpoint("c0", "c2"),
      },
    });
    await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });

    const claimed = await claimOne();

    expect(claimed.lastCheckpoint).toBe("c2");
    expect(claimed).not.toHaveProperty("rewind");
  });

  it("gives the delivered messages of the replaced step run to the reopen", async () => {
    const { claimOne, reopen } = await withFinishedStep({ message: true });
    await reopen();

    const claimed = await claimOne();

    expect(claimed.steps.at(-1)).toMatchObject({
      told: [{ author: "local", text: "Use Postgres" }],
    });
  });

  it("gives the session of the reopen after a crash in it", async () => {
    const { plane, claimOne, reopen } = await withFinishedStep();
    const { stepRunId } = await reopen();
    const { lease } = await claimOne();
    const { attemptId } = await plane.startAttempt(lease, stepRunId);
    await plane.finishAttempt(lease, attemptId, { result: { status: "failed", sessionId: "s2" } });
    await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });

    const claimed = await claimOne();

    expect(claimed.steps.at(-1)).toMatchObject({ sessionId: "s2" });
  });

  it("keeps the base of the first reopen when a reopen is reopened", async () => {
    const { api, plane, claimOne, reopen } = await withFinishedStep();
    const { stepRunId } = await reopen();
    const { lease } = await claimOne();
    const { attemptId } = await plane.startAttempt(lease, stepRunId);
    const fixed = { status: "succeeded" } as const;
    const result = { ...fixed, checkpoint: testCheckpoint("c0", "c2") };
    await plane.finishAttempt(lease, attemptId, { result, stepResult: fixed });
    await api.runs.sendMessage({ id: 1, stepRunId, text: "Use SQLite" });

    const claimed = await claimOne();

    expect(claimed.rewind).toMatchObject({ before: "c0", after: "c2" });
  });

  it("keeps the changes of the first reopen when a reopen without a checkpoint is reopened", async () => {
    const { api, plane, claimOne, reopen } = await withFinishedStep();
    const { stepRunId } = await reopen();
    const { lease } = await claimOne();
    const { attemptId } = await plane.startAttempt(lease, stepRunId);
    const failed = { status: "failed", summary: "The agent did not start" } as const;
    await plane.finishAttempt(lease, attemptId, { result: failed, stepResult: failed });
    await api.runs.sendMessage({ id: 1, stepRunId, text: "Use SQLite" });

    const claimed = await claimOne();

    expect(claimed.rewind).toMatchObject({ before: "c0", after: "c1" });
  });

  it("discards the workspace in the rewind when a later step ran", async () => {
    const { plane, lease, review, claimOne, reopen } = await withFinishedStep();
    await plane.startAttempt(lease, review);
    await reopen();

    const claimed = await claimOne();

    expect(claimed.rewind).toMatchObject({ hasLaterAttempts: true });
  });

  it("rewinds to the base of the run when the step run has no checkpoint", async () => {
    const { claimOne, reopen } = await withFinishedStep({ checkpoint: false });
    await reopen();

    const claimed = await claimOne();

    expect(claimed.rewind).toMatchObject({ before: baseSha, after: baseSha });
  });

  it("gives the delivered messages of the reopen to the claim", async () => {
    const { plane, claimOne, reopen } = await withFinishedStep();
    const { stepRunId } = await reopen();
    const { lease } = await claimOne();
    const { attemptId } = await plane.startAttempt(lease, stepRunId);
    await plane.appendEvents(lease, { batchId: "b1", events: [deliveringPrompt(attemptId, 1)] });
    await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });

    const claimed = await claimOne();

    expect(claimed.steps.at(-1)).toMatchObject({
      told: [{ author: "local", text: "Use SQLite" }],
    });
  });

  it("reopens a finished run", async () => {
    const { api, plane, lease, rounds, review, reopen } = await withFinishedStep();
    await plane.finishStep(lease, review, { status: "succeeded", outcome: "approve" });
    await plane.finishStep(lease, rounds, { status: "succeeded" });
    await plane.finishRun(lease, "succeeded");

    await reopen();

    const run = await api.runs.get({ id: 1 });

    expect(run.status).toBe("queued");
    expect(run).not.toHaveProperty("finishedAt");
  });

  it("clears the cancel request of a cancelled run at a reopen", async () => {
    const { api, plane, lease, reopen } = await withFinishedStep();
    await api.runs.cancel({ id: 1 });
    await plane.finishRun(lease, "cancelled");

    await reopen();

    expect(await api.runs.get({ id: 1 })).not.toHaveProperty("cancelRequestedAt");
  });

  it("answers 409 to a reopen of a live run with a cancel request", async () => {
    const { api, reopen } = await withFinishedStep();
    await api.runs.cancel({ id: 1 });

    await expect(reopen()).rejects.toMatchObject({
      status: 409,
      message: "Run 1 has a cancel request",
    });
  });

  it("answers 409 when another active run uses the branch of a finished run", async () => {
    const { api, plane, lease, reopen } = await withFinishedStep();
    await plane.finishRun(lease, "failed");
    await api.runs.create({ repoId: 1, workflow: "ship" });

    await expect(reopen()).rejects.toMatchObject({
      status: 409,
      message: "The run 2 uses the branch halinka/ship. Wait until it ends, or cancel it.",
    });
  });

  it("refuses a step run without attempts", async () => {
    const { api, plane, lease, review } = await withFinishedStep();
    await plane.finishStep(lease, review, { status: "skipped" });

    await expect(
      api.runs.sendMessage({ id: 1, stepRunId: review, text: "Use SQLite" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a superseded step run", async () => {
    const { api, claimOne, implement, reopen } = await withFinishedStep();
    await reopen();
    await claimOne();

    await expect(
      api.runs.sendMessage({ id: 1, stepRunId: implement, text: "Use SQLite" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a reopen of a queued run", async () => {
    const { reopen } = await withFinishedStep();
    await reopen();

    await expect(reopen()).rejects.toMatchObject({ status: 409, message: "Run 1 is not running" });
  });

  it("clears the run error when a person reopens a step", async () => {
    const { api, plane, startAgentStep } = await createConnectedTestServer(testDb());
    const { claimed, stepRunId, attemptId } = await startAgentStep();
    const succeeded = { status: "succeeded" } as const;
    await plane.finishAttempt(claimed.lease, attemptId, {
      result: succeeded,
      stepResult: succeeded,
    });
    await plane.finishRun(claimed.lease, "failed", "The container stopped");

    await api.runs.sendMessage({ id: 1, stepRunId, text: "Try again" });

    expect((await api.runs.get({ id: 1 })).error).toBeUndefined();
  });
});

const appToken = { owner: "acme", name: "app", token: "token-10" };

const finishedWithApp = async () => {
  const server = await finishedWithCheckpoint();
  const gitHub = new FakeGitHub();
  await connectApp(server.api, gitHub, [
    installationOf(10, [repoOf(100, "app"), repoOf(101, "other")]),
  ]);
  gitHub.requests.length = 0;
  return { ...server, gitHub };
};

const linkedToApp = async () => {
  const server = await finishedWithApp();
  await server.api.repos.linkGitHub({ id: 1, githubRepoId: 100 });
  return server;
};

const tokenRequests = (gitHub: FakeGitHub) => gitHub.readsOf("/app/installations/10/access_tokens");

const finishedOnGitHub = async () => {
  const server = await finishedWithApp();
  await makeGitHubRepo(testDb(), 1, 100);
  return server;
};

describe("POST /api/runs/{id}/push", () => {
  it("gives the runner the GitHub repo and the token of the App for a push", async () => {
    const { api, commands } = await finishedOnGitHub();

    await api.runs.push({ id: 1 });

    const [input] = commands.pushBranch.mock.calls[0]!;
    expect(input).toMatchObject({ githubRepoId: 100, github: appToken });
    expect(input).not.toHaveProperty("repoPath");
  });

  it("fails for a `github` repo with no App", async () => {
    const { api } = await finishedOnGitHub();
    await api.github.disconnect();

    await expect(api.runs.push({ id: 1 })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("needs the App"),
    });
  });

  it("does not call the runner for a `github` repo with no App", async () => {
    const { api, commands } = await finishedOnGitHub();
    await api.github.disconnect();

    await api.runs.push({ id: 1 }).catch(() => {});

    expect(commands.pushBranch).not.toHaveBeenCalled();
  });

  it("gives the token of the App and its repo to the push", async () => {
    const { api, commands } = await linkedToApp();

    await api.runs.push({ id: 1 });

    expect(commands.pushBranch).toHaveBeenCalledWith(expect.objectContaining({ github: appToken }));
  });

  it("asks for a push token of that repo, which can only write contents", async () => {
    const { api, gitHub } = await linkedToApp();

    await api.runs.push({ id: 1 });

    expect(tokenRequests(gitHub).map(({ body }) => body)).toEqual([
      { repository_ids: [100], permissions: { contents: "write" } },
    ]);
  });

  it("names the repo as GitHub names it now", async () => {
    const { api, commands, gitHub } = await linkedToApp();
    gitHub.installations = [installationOf(10, [repoOf(100, "renamed", "new-owner")])];

    await api.runs.push({ id: 1 });

    expect(commands.pushBranch).toHaveBeenCalledWith(
      expect.objectContaining({ github: { ...appToken, owner: "new-owner", name: "renamed" } }),
    );
  });

  it("gives no token to a repo without a link", async () => {
    const { api, commands, gitHub } = await finishedWithApp();

    await api.runs.push({ id: 1 });

    expect(commands.pushBranch.mock.lastCall?.[0].github).toBeUndefined();
    expect(tokenRequests(gitHub)).toEqual([]);
  });

  it("gives no token after a disconnect", async () => {
    const { api, commands } = await linkedToApp();
    await api.github.disconnect();

    await api.runs.push({ id: 1 });

    expect(commands.pushBranch.mock.lastCall?.[0].github).toBeUndefined();
  });

  it("does not call the runner when the repo left the installation", async () => {
    const { api, commands, gitHub } = await linkedToApp();
    gitHub.installations = [installationOf(10, [repoOf(101, "other")])];
    await api.github.refresh();

    await expect(api.runs.push({ id: 1 })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("no access to this GitHub repo"),
    });
    expect(commands.pushBranch).not.toHaveBeenCalled();
  });

  it("does not call the runner when GitHub gives a token without the repo", async () => {
    const { api, commands, gitHub } = await linkedToApp();
    gitHub.installations = [installationOf(10, [repoOf(101, "other")])];

    await expect(api.runs.push({ id: 1 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "GitHub gave a token for another repo",
    });
    expect(commands.pushBranch).not.toHaveBeenCalled();
  });

  it("asks for no token when the runner is offline", async () => {
    const { api, disconnect, gitHub } = await linkedToApp();
    disconnect();

    await expect(api.runs.push({ id: 1 })).rejects.toMatchObject({ code: "RUNNER_OFFLINE" });
    expect(tokenRequests(gitHub)).toEqual([]);
  });

  it("pushes the last checkpoint with the run's branch and base", async () => {
    const { api, commands } = await finishedWithCheckpoint();

    await api.runs.push({ id: 1 });

    expect(commands.pushBranch).toHaveBeenCalledWith({
      workflowRunId: 1,
      repoPath,
      branch: "halinka/run-1",
      baseSha,
      commit: "c1",
    });
  });

  it("gives the runner the pull request of a pull request run", async () => {
    const { api, commands } = await finishedWithCheckpoint();
    await testDb().update(workflowRuns).set({ pullRequestNumber: 7 });

    await api.runs.push({ id: 1 });

    expect(commands.pushBranch).toHaveBeenCalledWith(
      expect.objectContaining({ pullRequestNumber: 7 }),
    );
  });

  it("stores the pushed commit on the run", async () => {
    const { api } = await finishedWithCheckpoint();

    expect(await api.runs.push({ id: 1 })).toEqual({ pushedCommit: "c1" });
    expect((await api.runs.get({ id: 1 })).pushedCommit).toBe("c1");
  });

  it("gives the pushed commit to the next push as its lease", async () => {
    const { api, commands } = await finishedWithCheckpoint();
    await api.runs.push({ id: 1 });

    await api.runs.push({ id: 1 });

    expect(commands.pushBranch).toHaveBeenLastCalledWith(
      expect.objectContaining({ pushedCommit: "c1" }),
    );
  });

  it("gives a later run on the same branch the commit of the earlier push as its lease", async () => {
    const server = await createConnectedTestServer(testDb());
    const { api, files, commands } = server;
    files[".halinka/workflows/feature.yml"] =
      "schema_version: 1\nname: Feature\nbranch:\n  name: feature\nsteps:\n  - { id: build, type: shell, run: ls }\n";
    await api.runs.create({ repoId: 1, workflow: "feature" });
    await finishBuild(server, "c1");
    await api.runs.push({ id: 1 });
    await api.runs.create({ repoId: 1, workflow: "feature" });
    await finishBuild(server, "c2");

    await api.runs.push({ id: 2 });

    expect(commands.pushBranch).toHaveBeenLastCalledWith(
      expect.objectContaining({ branch: "feature", commit: "c2", pushedCommit: "c1" }),
    );
  });

  it("refuses an active run", async () => {
    const { api, commands, queue, claimOne } = await createConnectedTestServer(testDb());
    await queue();
    await claimOne();

    await expect(api.runs.push({ id: 1 })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Run 1 is active. Cancel it first.",
    });
    expect(commands.pushBranch).not.toHaveBeenCalled();
  });

  it("refuses a run that changed nothing", async () => {
    const { api, finishOne } = await createConnectedTestServer(testDb());
    await finishOne();

    await expect(api.runs.push({ id: 1 })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Run 1 changed nothing to push",
    });
  });

  it("answers 404 for a run that is being deleted", async () => {
    const { api } = await finishedWithCheckpoint();
    await testDb().update(workflowRuns).set({ deletingAt: new Date() });

    await expect(api.runs.push({ id: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps no pushed commit when the runner refuses the push", async () => {
    const { api, commands } = await finishedWithCheckpoint();
    commands.pushBranch.mockRejectedValueOnce(conflict("The branch halinka/run-1 moved"));

    await expect(api.runs.push({ id: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await api.runs.get({ id: 1 })).pushedCommit).toBeUndefined();
  });

  it("refuses to store over a commit that another push stored first", async () => {
    const { api, commands } = await finishedWithCheckpoint();
    commands.pushBranch.mockImplementationOnce(async () => {
      await testDb()
        .insert(pushedBranches)
        .values({ repoId: 1, branch: "halinka/run-1", commit: "c2" });
    });

    await expect(api.runs.push({ id: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await api.runs.get({ id: 1 })).pushedCommit).toBe("c2");
  });

  it("refuses to store the commit of a repo that was deleted during the push", async () => {
    const { api, commands } = await finishedWithCheckpoint();
    commands.pushBranch.mockImplementationOnce(async () => {
      await testDb().execute(sql`truncate repos cascade`);
    });

    await expect(api.runs.push({ id: 1 })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "The repo of the branch halinka/run-1 was deleted during the push.",
    });
  });

  it("tells that the push can be on GitHub when the runner disconnects during it", async () => {
    const { api, commands } = await finishedWithCheckpoint();
    commands.pushBranch.mockRejectedValueOnce(connectionClosed());

    await expect(api.runs.push({ id: 1 })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("The push or the pull request can be on GitHub"),
    });
  });

  it("answers CONFLICT when the runner does not answer in time", async () => {
    const { api, commands } = await finishedWithCheckpoint();
    const timeout = new ProtocolError("timeout", "The runner did not answer in 60 s");
    commands.pushBranch.mockRejectedValueOnce(timeout);

    await expect(api.runs.push({ id: 1 })).rejects.toMatchObject({
      code: "CONFLICT",
      message:
        "The runner did not answer in 60 s. The command can still take effect: check its result before you try again.",
    });
  });
});

describe("POST /api/runs/{id}/pull-request", () => {
  const pullRequestUrl = "https://github.com/acme/app/pull/1";

  it("answers the URL of the pull request", async () => {
    const { api } = await finishedWithCheckpoint();

    expect(await api.runs.openPullRequest({ id: 1 })).toEqual({ pullRequestUrl });
  });

  it("stores the pushed commit and the URL of the pull request", async () => {
    const { api } = await finishedWithCheckpoint();

    await api.runs.openPullRequest({ id: 1 });

    expect(await api.runs.get({ id: 1 })).toMatchObject({ pushedCommit: "c1", pullRequestUrl });
  });

  it("sends the workflow name and the run in the title and the body", async () => {
    const { api, commands } = await finishedWithCheckpoint();

    await api.runs.openPullRequest({ id: 1 });

    expect(commands.openPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        commit: "c1",
        title: "Build (Halinka run #1)",
        body: "Opened from Halinka run #1.",
      }),
    );
  });

  it("answers CONFLICT when GitHub refuses the pull request", async () => {
    const { api, commands } = await finishedWithCheckpoint();
    commands.openPullRequest.mockResolvedValueOnce({ error: "GitHub answered 422: No drafts" });

    await expect(api.runs.openPullRequest({ id: 1 })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "The branch is on GitHub. The pull request failed: GitHub answered 422: No drafts",
    });
  });

  it("refuses a pull request URL outside github.com", async () => {
    const { api, commands } = await finishedWithCheckpoint();
    commands.openPullRequest.mockResolvedValueOnce({ url: "javascript:alert(1)", isCreated: true });

    await expect(api.runs.openPullRequest({ id: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await api.runs.get({ id: 1 })).pullRequestUrl).toBeUndefined();
  });

  it("stores the pushed commit when the pull request fails after the push", async () => {
    const { api, commands } = await finishedWithCheckpoint();
    commands.openPullRequest.mockResolvedValueOnce({ error: "GitHub answered 422: No drafts" });
    await api.runs.openPullRequest({ id: 1 }).catch(() => {});
    const { pushedCommit, pullRequestUrl } = await api.runs.get({ id: 1 });

    expect({ pushedCommit, pullRequestUrl }).toEqual({ pushedCommit: "c1" });
  });

  it("keeps the URL of the pull request when a later push of the branch stores its commit", async () => {
    const server = await createConnectedTestServer(testDb());
    const { api, files } = server;
    files[".halinka/workflows/feature.yml"] =
      "schema_version: 1\nname: Feature\nbranch:\n  name: feature\nsteps:\n  - { id: build, type: shell, run: ls }\n";
    await api.runs.create({ repoId: 1, workflow: "feature" });
    await finishBuild(server, "c1");
    await api.runs.openPullRequest({ id: 1 });
    await api.runs.create({ repoId: 1, workflow: "feature" });
    await finishBuild(server, "c2");

    await api.runs.push({ id: 2 });

    expect(await api.runs.get({ id: 2 })).toMatchObject({ pushedCommit: "c2", pullRequestUrl });
  });

  it("refuses a run that did not succeed", async () => {
    const { api, commands } = await finishedWithCheckpoint("failed");

    await expect(api.runs.openPullRequest({ id: 1 })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Run 1 did not succeed, so it opens no pull request",
    });
    expect(commands.openPullRequest).not.toHaveBeenCalled();
  });

  it("gives the token of the App and its repo to the pull request", async () => {
    const { api, commands } = await linkedToApp();

    await api.runs.openPullRequest({ id: 1 });

    expect(commands.openPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ github: appToken }),
    );
  });

  it("asks for a pull request token that can also write pull requests", async () => {
    const { api, gitHub } = await linkedToApp();

    await api.runs.openPullRequest({ id: 1 });

    expect(tokenRequests(gitHub).map(({ body }) => body)).toEqual([
      {
        repository_ids: [100],
        permissions: { contents: "write", pull_requests: "write", metadata: "read" },
      },
    ]);
  });

  it("does not call the runner when GitHub refuses the token", async () => {
    const { api, commands, gitHub } = await linkedToApp();
    gitHub.refuseWith = Response.json({ message: "Suspended" }, { status: 403 });

    await expect(api.runs.openPullRequest({ id: 1 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "GitHub answered 403: Suspended",
    });
    expect(commands.openPullRequest).not.toHaveBeenCalled();
  });

  const reviewer = (id: string) =>
    `  - { id: ${id}, type: agent, agent: claude-code, permissions: { write: false }, prompt: Review }`;

  // `reviews`: the steps of the workflow with the commit of each, in their order; `build` ends with c1.
  const shipped = async (steps: string[], reviews: [string, string][]) => {
    const server = await createConnectedTestServer(testDb());
    const { api, files, claimOne, plane } = server;
    files[".halinka/workflows/ship.yml"] = [
      "schema_version: 1",
      "name: Ship",
      "steps:",
      ...steps,
    ].join("\n");
    await api.runs.create({ repoId: 1, workflow: "ship" });
    const { lease } = await claimOne();
    for (const [stepId, after] of reviews) await finishStep(server, lease, { stepId, after });
    await plane.finishRun(lease, "succeeded");
    return server;
  };

  const oneApproval = [
    reviewer("review"),
    "  - { id: approve, type: approval, message: Ship it, reviewers: [review] }",
    "  - { id: build, type: shell, run: ls }",
  ];

  it("refuses a pull request when a reviewer of the last approval reviewed an older commit", async () => {
    const { api, commands } = await shipped(oneApproval, [
      ["review", "c0"],
      ["approve", "c0"],
      ["build", "c1"],
    ]);

    await expect(api.runs.openPullRequest({ id: 1 })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "The step `review` reviewed c0, but the branch is at c1.",
    });
    expect(commands.openPullRequest).not.toHaveBeenCalled();
  });

  it("checks only the reviewers of the last approval", async () => {
    const twoApprovals = [
      reviewer("early"),
      "  - { id: first, type: approval, message: One, reviewers: [early] }",
      "  - { id: build, type: shell, run: ls }",
      reviewer("late"),
      "  - { id: second, type: approval, message: Two, reviewers: [late] }",
    ];
    const { api } = await shipped(twoApprovals, [
      ["early", "c0"],
      ["first", "c0"],
      ["build", "c1"],
      ["late", "c1"],
      ["second", "c1"],
    ]);

    expect(await api.runs.openPullRequest({ id: 1 })).toEqual({ pullRequestUrl });
  });
});

describe("POST /api/runs/{id}/steps/{stepRunId}/retry", () => {
  it("queues the run", async () => {
    const { api, publish } = await finishPublish("failed");

    await api.runs.retryStep({ id: 1, stepRunId: publish });

    expect(await api.runs.get({ id: 1 })).toMatchObject({ status: "queued" });
  });

  it("offers nothing after the retry", async () => {
    const { api, publish } = await finishPublish("failed");

    await api.runs.retryStep({ id: 1, stepRunId: publish });

    expect((await api.runs.get({ id: 1 })).retryTargets).toEqual([]);
  });

  it("gives a new step run", async () => {
    const { api, publish } = await finishPublish("failed");

    const { stepRunId } = await api.runs.retryStep({ id: 1, stepRunId: publish });

    expect(stepRunId).not.toBe(publish);
  });

  it("wakes the runner", async () => {
    const { api, commands, publish } = await finishPublish("failed");
    commands.wake.mockClear();

    await api.runs.retryStep({ id: 1, stepRunId: publish });

    expect(commands.wake).toHaveBeenCalled();
  });

  it("gives the next engine the step run with the same commit", async () => {
    const { api, plane, claimOne, publish } = await finishPublish("failed");
    const { stepRunId } = await api.runs.retryStep({ id: 1, stepRunId: publish });

    const { lease } = await claimOne();

    expect(await plane.readPushAccess(lease, stepRunId)).toMatchObject({ commit: "c1" });
  });

  it("refuses a step of another kind", async () => {
    const server = await createConnectedTestServer(testDb());
    await server.api.runs.create({ repoId: 1, workflow: "build" });
    const { lease } = await server.claimOne();
    const build = await server.plane.startStep(lease, "build");
    await server.plane.finishStep(lease, build, { status: "failed" });

    await expect(server.api.runs.retryStep({ id: 1, stepRunId: build })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("refuses a github step that succeeded", async () => {
    const { api, publish } = await finishPublish("succeeded");

    await expect(api.runs.retryStep({ id: 1, stepRunId: publish })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("answers 404 for a step run that the run does not have", async () => {
    const { api } = await finishPublish("failed");

    await expect(api.runs.retryStep({ id: 1, stepRunId: 999 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("POST /api/runs/tests", () => {
  const path = ".halinka/workflows/publish.yml";

  const draftOf = (name = "Draft") => publishWorkflow.replace("name: Publish", `name: ${name}`);

  const withBranch = (name: string) =>
    draftOf().replace("steps:\n", `branch:\n  name: ${name}\nsteps:\n`);

  const setUp = async () => {
    const server = await createConnectedTestServer(testDb());
    server.files[path] = publishWorkflow;
    const { hash } = await server.api.repos.workflow({ id: 1, workflow: "publish" });
    const test = (source = draftOf(), baseHash = hash) =>
      server.api.runs.test({ repoId: 1, workflow: "publish", source, baseHash });
    return { ...server, hash, test };
  };

  const claimDevcontainer = async (server: Awaited<ReturnType<typeof setUp>>) => {
    server.files[".halinka/config.yml"] = devcontainerConfig;
    const { id } = await server.test();
    return { id, claimed: await server.claimOne([], "devcontainer") };
  };

  it("marks the run as a test run", async () => {
    const { api, test } = await setUp();

    const { id } = await test();

    expect(await api.runs.get({ id })).toMatchObject({ isTestRun: true });
  });

  it("runs the source of the draft", async () => {
    const server = await setUp();

    const { claimed } = await claimDevcontainer(server);

    expect(claimed.workflow.name).toBe("Draft");
  });

  it("tells the runner", async () => {
    const server = await setUp();

    const { claimed } = await claimDevcontainer(server);

    expect(claimed.isTestRun).toBe(true);
  });

  it("refuses a draft of an older file", async () => {
    const { test } = await setUp();

    await expect(test(draftOf(), "other-hash")).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a draft that does not parse", async () => {
    const { test } = await setUp();

    await expect(test("name: [")).rejects.toMatchObject({ code: "INVALID_WORKFLOW" });
  });

  it("ignores the branch name of the draft", async () => {
    const { api, test } = await setUp();

    const { id } = await test(withBranch("fixed"));

    expect(await api.runs.get({ id })).toMatchObject({ branch: `halinka/run-${id}` });
  });

  it("does not hold a branch name that a usual run needs", async () => {
    const { api, test, files } = await setUp();
    await test(withBranch("fixed"));
    files[path] = withBranch("fixed");

    await expect(api.runs.create({ repoId: 1, workflow: "publish" })).resolves.toBeDefined();
  });

  it("refuses a branch name that the inputs make invalid", async () => {
    const { test } = await setUp();
    const source = withBranch("x/${{ inputs.name }}").replace(
      "steps:\n",
      "inputs:\n  name: { type: string, default: a..b }\nsteps:\n",
    );

    await expect(test(source)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a draft over the file limit in bytes", async () => {
    const { test } = await setUp();
    const source = `${draftOf()}# ${"é".repeat(600 * 1024)}\n`;

    await expect(test(source)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("goes to no worktree runner", async () => {
    const { plane, test } = await setUp();
    await test();

    const { claimed } = await plane.sync({ held: [], capacity: 1, capabilities: worktreeRunner });

    expect(claimed).toEqual([]);
  });

  it("says why a worktree runner does not take it", async () => {
    const { api, plane, test } = await setUp();
    const { id } = await test();
    await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });

    expect((await api.runs.get({ id })).waitReason).toContain("is a test of a draft");
  });

  const secretConfig = `${devcontainerConfig}setup:\n  run: npm ci\n  secrets: [NPM_TOKEN]\n`;

  it("starts with a setup secret that the repo does not have", async () => {
    const { files, test } = await setUp();
    files[".halinka/config.yml"] = secretConfig;

    await expect(test()).resolves.toBeDefined();
  });

  it("skips a setup that needs secrets", async () => {
    const server = await setUp();
    server.files[".halinka/config.yml"] = secretConfig;
    await server.api.repos.setSecret({ id: 1, name: "NPM_TOKEN", value: "npm_made_up_value" });
    await server.test();

    const claimed = await server.claimOne([], "devcontainer");

    expect(claimed).not.toHaveProperty("setupRun");
  });

  it("says that it skipped the setup", async () => {
    const { api, files, test } = await setUp();
    files[".halinka/config.yml"] = secretConfig;

    const { id } = await test();

    expect(await api.runs.get({ id })).toMatchObject({ isSetupSkipped: true });
  });

  it("says nothing for a setup with no secrets", async () => {
    const { api, files, test } = await setUp();
    files[".halinka/config.yml"] = `${devcontainerConfig}setup:\n  run: npm ci\n`;

    const { id } = await test();

    expect(await api.runs.get({ id })).toMatchObject({ isSetupSkipped: false });
  });

  it("gives no setup secrets to a runner that asks", async () => {
    const server = await setUp();
    server.files[".halinka/config.yml"] = secretConfig;
    await server.api.repos.setSecret({ id: 1, name: "NPM_TOKEN", value: "npm_made_up_value" });
    await server.test();
    const { lease } = await server.claimOne([], "devcontainer");

    expect(await server.plane.readSetupSecrets(lease)).toEqual({ values: [], missing: [] });
  });

  it("runs a setup with no secrets", async () => {
    const server = await setUp();
    server.files[".halinka/config.yml"] = `${devcontainerConfig}setup:\n  run: npm ci\n`;
    await server.test();

    const claimed = await server.claimOne([], "devcontainer");

    expect(claimed.setupRun).toBe("npm ci");
  });

  const finished = async () => {
    const server = await setUp();
    const { id, claimed } = await claimDevcontainer(server);
    const { lease } = claimed;
    await finishStep(server, lease, { stepId: "build", after: "c1" });
    const stepRunId = await server.plane.startStep(lease, "publish");
    return { ...server, id, lease, stepRunId };
  };

  const refused = { code: "conflict", message: expect.stringContaining("is a test run") };

  it("gives no token to a github step", async () => {
    const { plane, lease, stepRunId } = await finished();

    await expect(plane.readPushAccess(lease, stepRunId)).rejects.toMatchObject(refused);
  });

  it("stores no push of a github step", async () => {
    const { plane, lease, stepRunId } = await finished();

    await expect(plane.storePushedBranch(lease, stepRunId, {})).rejects.toMatchObject(refused);
  });

  const ended = async () => {
    const { plane, lease, stepRunId, ...server } = await finished();
    await plane.finishStep(lease, stepRunId, { status: "succeeded" });
    await plane.finishRun(lease, "succeeded");
    return server;
  };

  it("refuses Push branch", async () => {
    const { api, id } = await ended();

    await expect(api.runs.push({ id })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("is a test run"),
    });
  });

  it("refuses Open PR", async () => {
    const { api, id } = await ended();

    await expect(api.runs.openPullRequest({ id })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("is a test run"),
    });
  });

  it("offers no push", async () => {
    const { api, id } = await ended();

    expect(await api.runs.get({ id })).toMatchObject({ canPush: false });
  });

  it("offers no pull request", async () => {
    const { api, id } = await ended();

    expect(await api.runs.get({ id })).toMatchObject({ canOpenPullRequest: false });
  });
});
