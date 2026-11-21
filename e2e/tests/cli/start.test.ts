import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { fakeAgentPrompt } from "@halinka/agents/testing";
import { pathExists } from "@halinka/utils/fs";
import { expect } from "@playwright/test";

import { shellWorkflow, test, TestRepo } from "../utils";

// After a crash the wait step keeps running; it ends with the release file, or after 60 s.
const waitWorkflow = (release: string) => {
  const wait = `for i in $(seq 600); do [ -f ${release} ] && exit 0; sleep 0.1; done; exit 1`;
  return [
    "schema_version: 1",
    "name: Wait",
    "steps:",
    "  - { id: first, type: shell, run: echo first >> first.log }",
    `  - { id: wait, type: shell, run: ${JSON.stringify(wait)} }`,
    "  - { id: last, type: shell, run: echo last > last.log }",
    "",
  ].join("\n");
};

test.describe("halinka start", () => {
  test("runs the server and a runner on PGlite in HALINKA_HOME", async ({ halinka }) => {
    const server = await halinka.start();
    await server.expectRunnerConnected();
    await server.expectHealthy();
    await halinka.expectDatabase();
    await server.stop();
  });

  test("prints the problems of a repo config that is not valid", async ({ halinka }) => {
    const repo = await halinka.createRepo({ ".halinka/config.yml": "server: local\n" });

    const server = await halinka.start([], repo.path);

    await server.expectRepoConfigProblem("1:1 This file is from an older Halinka.");
  });

  test("says that it registers no repo in a repo without .halinka", async ({ halinka }) => {
    const repo = await halinka.createRepo();

    const server = await halinka.start([], repo.path);

    await server.expectOutput(`${repo.path} has no .halinka/config.yml. start registers no repo.`);
  });

  test("says that it registers no repo of another server", async ({ halinka }) => {
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: https://halinka.example.com\n",
    });

    const server = await halinka.start([], repo.path);

    await server.expectOutput(
      "names the server https://halinka.example.com. start registers no repo.",
    );
  });

  test("warns when the repo has no devcontainer and the runner runs in one", async ({
    halinka,
  }) => {
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: local\n",
    });

    const server = await halinka.start(["--runs-in", "devcontainer"], repo.path);

    await server.expectOutput(
      "names no devcontainer, and the runner runs workflows in a devcontainer",
    );
  });

  test("registers the repo when it has no devcontainer and the runner runs in one", async ({
    halinka,
  }) => {
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: local\n",
    });

    const server = await halinka.start(["--runs-in", "devcontainer"], repo.path);

    await server.expectRepoRegistered(repo.path);
  });

  test("does not warn of a missing devcontainer when the runner runs in a worktree", async ({
    halinka,
  }) => {
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: local\n",
    });
    const server = await halinka.start([], repo.path);
    await server.expectRepoRegistered(repo.path);

    await server.stop();

    await server.expectNoOutputAtClose("names no devcontainer");
  });

  test("names the missing key of the smoke agent in a new repo", async ({ halinka }) => {
    halinka.setEnv("ANTHROPIC_API_KEY", "");
    halinka.setEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    const repo = await halinka.createRepo();
    await halinka.init(repo, ["--yes"]).expectExit(0);

    const server = await halinka.start(["--runs-in", "devcontainer"], repo.path);

    await server.expectOutput(`Add a key of claude-code on the Agents page: ${server.url}/agents`);
  });

  test("links the smoke workflow of a new repo", async ({ halinka }) => {
    const repo = await halinka.createRepo();
    await halinka.init(repo, ["--server", "local", "--devcontainer", "none"]).expectExit(0);

    const server = await halinka.start([], repo.path);

    await server.expectOutput(
      `Start the smoke workflow: ${server.url}/repos/1/workflows/smoke.yml`,
    );
  });

  test("names no key of an agent that has a key", async ({ halinka }) => {
    halinka.setEnv("ANTHROPIC_API_KEY", "");
    halinka.setEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    const repo = await halinka.createRepo();
    await halinka.init(repo, ["--yes"]).expectExit(0);
    const first = await halinka.start(["--runs-in", "devcontainer"], repo.path);
    await first.expectRepoRegistered(repo.path);
    const key = ["agent", "key", "claude-code", "ANTHROPIC_API_KEY"];
    await halinka.run(key).input("sk-ant-api03-made-up-value").expectExit(0);
    await first.stop();

    const server = await halinka.start(["--runs-in", "devcontainer"], repo.path);
    await server.expectOutput("Start the smoke workflow");
    await server.stop();

    await server.expectNoOutputAtClose("Add a key");
  });

  test("names no key for a runner in a worktree", async ({ halinka }) => {
    const repo = await halinka.createRepo();
    await halinka.init(repo, ["--yes"]).expectExit(0);
    const server = await halinka.start([], repo.path);
    await server.expectOutput("Start the smoke workflow");

    await server.stop();

    await server.expectNoOutputAtClose("Add a key");
  });

  test("names no key of an agent with a key in the environment", async ({ halinka }) => {
    halinka.setEnv("ANTHROPIC_API_KEY", "sk-ant-api03-made-up-value");
    const repo = await halinka.createRepo();
    await halinka.init(repo, ["--yes"]).expectExit(0);
    const server = await halinka.start(["--runs-in", "devcontainer"], repo.path);
    await server.expectOutput("Start the smoke workflow");

    await server.stop();

    await server.expectNoOutputAtClose("Add a key");
  });

  test("gives no next steps after the warning of a missing devcontainer", async ({ halinka }) => {
    const repo = await halinka.createRepo();
    await halinka.init(repo, ["--server", "local", "--devcontainer", "none"]).expectExit(0);
    const server = await halinka.start(["--runs-in", "devcontainer"], repo.path);
    await server.expectOutput("names no devcontainer");

    await server.stop();

    await server.expectNoOutputAtClose("Next steps");
  });

  test("gives no next steps when the repo has a run", async ({ halinka }) => {
    await halinka.installFakeAgent("claude-code");
    const repo = await halinka.createRepo();
    await halinka.init(repo, ["--server", "local", "--devcontainer", "none"]).expectExit(0);
    const first = await halinka.start([], repo.path);
    await first.expectRepoRegistered(repo.path);
    expect((await first.post("/api/runs", { repoId: 1, workflow: "smoke" })).status).toBe(201);
    await first.stop();
    const server = await halinka.start([], repo.path);
    await server.expectRepoRegistered(repo.path);

    await server.stop();

    await server.expectNoOutputAtClose("Next steps");
  });

  test("says that it registers no repo outside a git repo", async ({ halinka }) => {
    const folder = await halinka.createFolder();

    const server = await halinka.start([], folder);

    await server.expectOutput("This folder is not in a git repository. start registers no repo.");
  });

  test("starts again on the same database", async ({ halinka }) => {
    await (await halinka.start()).stop();
    const server = await halinka.start();
    await server.expectHealthy();
    await server.stop();
  });

  test("exits when another runner has the name of this machine", async ({ halinka }) => {
    await (await halinka.start()).stop();
    const keyPath = join(halinka.home, "runner.json");
    await rm(keyPath);

    const process = halinka.run(["start", "--port", "0"]);

    await process.expectOutput(
      `Set another "name" in ${keyPath}, or restore the runner.json of that runner.`,
    );
    await process.expectExit(1);
  });

  test("exits when an Admin revoked the runner of this machine", async ({ halinka }) => {
    const server = await halinka.start();
    await server.postJson("/api/runners/1/revoke", {});
    await server.stop();

    const process = halinka.run(["start", "--port", "0"]);

    await process.expectOutput("An Admin revoked this runner");
    await process.expectExit(1);
  });

  test("queues a run in the repo that it starts in", async ({ halinka }) => {
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: local\n",
      ".halinka/workflows/build.yml": shellWorkflow("ls"),
    });
    const server = await halinka.start([], repo.path);
    await server.expectRepoRegistered(repo.path);
    const response = await server.post("/api/runs", { repoId: 1, workflow: "build" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: 1, status: "queued" });
    await server.stop();
  });

  test("resumes a run after a restart without repeating its finished steps", async ({
    halinka,
  }) => {
    const release = join(await halinka.createFolder(), "release");
    const { repo, server: first } = await halinka.startInRepo({
      "wait.yml": waitWorkflow(release),
    });
    await first.postJson("/api/runs", { repoId: 1, workflow: "wait" });
    const workspace = await halinka.findWorkspaceFolder(1);
    await expect
      .poll(() => first.get("/api/runs/1"))
      .toMatchObject({
        stepRuns: expect.arrayContaining([
          expect.objectContaining({ stepId: "first", status: "succeeded" }),
        ]),
      });
    await first.stop();

    const second = await halinka.start([], repo.path);
    await writeFile(release, "");
    await expect
      .poll(() => readFile(join(workspace, "last.log"), "utf8").catch(() => ""))
      .toBe("last\n");
    await new TestRepo(workspace).expectFile("first.log", "first\n");
    await second.stop();
  });

  test("continues a run in a new attempt after a crash", async ({ halinka }) => {
    halinka.shortenLeases();
    const release = join(await halinka.createFolder(), "release");
    const { repo, server: crashed } = await halinka.startInRepo({
      "wait.yml": waitWorkflow(release),
    });
    await crashed.postJson("/api/runs", { repoId: 1, workflow: "wait" });
    await expect
      .poll(() => crashed.get("/api/runs/1"))
      .toMatchObject({
        stepRuns: expect.arrayContaining([
          expect.objectContaining({ stepId: "wait", status: "running" }),
        ]),
        attempts: expect.arrayContaining([
          expect.objectContaining({ attempt: 1, status: "running" }),
        ]),
      });
    await crashed.crash();

    const server = await halinka.start([], repo.path);
    await writeFile(release, "");

    await expect
      .poll(() => server.get("/api/runs/1"), { timeout: 45_000 })
      .toMatchObject({
        status: "succeeded",
        attempts: expect.arrayContaining([expect.objectContaining({ status: "lost" })]),
      });
    await server.stop();
  });

  test("continues a run that waits for an approval when a person approves", async ({ halinka }) => {
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: local\n",
      ".halinka/workflows/ship.yml": [
        "schema_version: 1",
        "name: Ship",
        "steps:",
        "  - { id: approve, type: approval, message: Check the diff }",
        "  - { id: after, type: shell, run: echo after > after.log }",
        "",
      ].join("\n"),
    });

    const server = await halinka.start([], repo.path);
    await server.expectRepoRegistered(repo.path);
    expect((await server.post("/api/runs", { repoId: 1, workflow: "ship" })).status).toBe(201);
    await expect.poll(() => server.get("/api/runs/1")).toMatchObject({ status: "waiting_input" });
    const [item] = (await server.get("/api/inbox")) as { id: number }[];
    expect(item).toMatchObject({ workflowRunId: 1, message: "Check the diff" });
    const resolve = await server.post(`/api/inbox/${item?.id}/resolve`, { decision: "approve" });
    expect(resolve.status).toBe(200);

    await expect.poll(() => server.get("/api/runs/1")).toMatchObject({ status: "succeeded" });
    await new TestRepo(await halinka.findWorkspaceFolder(1)).expectFile("after.log", "after\n");
    await server.stop();
  });

  test("runs an agent step with the agent on the PATH", async ({ halinka }) => {
    await halinka.installFakeAgent("claude-code");
    const prompt = fakeAgentPrompt([[{ report: { summary: "Done" } }]]);
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: local\n",
      ".halinka/workflows/agent.yml": [
        "schema_version: 1",
        "name: Agent",
        "steps:",
        `  - { id: work, type: agent, agent: claude-code, require_changes: false, prompt: ${JSON.stringify(prompt)} }`,
        "  - { id: after, type: shell, run: echo after > after.log }",
        "",
      ].join("\n"),
    });

    const server = await halinka.start([], repo.path);
    await server.expectRepoRegistered(repo.path);
    expect((await server.post("/api/runs", { repoId: 1, workflow: "agent" })).status).toBe(201);
    const workspace = await halinka.findWorkspaceFolder(1);

    await expect.poll(() => pathExists(join(workspace, "after.log"))).toBe(true);
    await server.stop();
  });

  test("runs a workflow on the branch that its inputs name", async ({ halinka }) => {
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: local\n",
      ".halinka/workflows/fix.yml": [
        "schema_version: 1",
        "name: Fix",
        "inputs:",
        "  issue: { type: number, required: true }",
        "branch:",
        "  name: fix/issue-${{ inputs.issue }}",
        "steps:",
        "  - { id: notes, type: shell, run: echo notes > notes.md }",
        "",
      ].join("\n"),
    });

    const server = await halinka.start([], repo.path);
    await server.expectRepoRegistered(repo.path);
    const run = { repoId: 1, workflow: "fix", inputs: { issue: "12" } };
    expect((await server.post("/api/runs", run)).status).toBe(201);

    await repo.expectCommittedFile("fix/issue-12", "notes.md", "notes\n");
    await server.stop();
  });

  test("commits the changes of an agent step on the run branch", async ({ halinka }) => {
    await halinka.installFakeAgent("claude-code");
    const prompt = fakeAgentPrompt([
      [
        { write: { path: "notes.md", text: "notes\n" } },
        { report: { summary: "Wrote the notes" } },
      ],
    ]);
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: local\n",
      ".halinka/workflows/agent.yml": [
        "schema_version: 1",
        "name: Agent",
        "steps:",
        `  - { id: work, type: agent, agent: claude-code, prompt: ${JSON.stringify(prompt)} }`,
        "",
      ].join("\n"),
    });

    const server = await halinka.start([], repo.path);
    await server.expectRepoRegistered(repo.path);
    expect((await server.post("/api/runs", { repoId: 1, workflow: "agent" })).status).toBe(201);

    await repo.expectCommittedFile("halinka/run-1", "notes.md", "notes\n");
    await server.stop();
  });

  test("removes the workspace of a finished run when a person asks", async ({ halinka }) => {
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: local\n",
      ".halinka/workflows/build.yml": shellWorkflow("ls"),
    });
    const server = await halinka.start([], repo.path);
    await server.expectRepoRegistered(repo.path);
    await server.postJson("/api/runs", { repoId: 1, workflow: "build" });
    const workspace = await halinka.findWorkspaceFolder(1);
    const readRunSandbox = async () =>
      ((await server.get("/api/runs/1")) as { sandbox: unknown }).sandbox;
    await expect.poll(readRunSandbox).toMatchObject({ spec: "stopped", observed: "stopped" });
    expect(await pathExists(workspace)).toBe(true);

    expect((await server.delete("/api/runs/1/sandbox")).status).toBe(200);

    await expect.poll(readRunSandbox).toMatchObject({ spec: "destroyed", observed: "absent" });
    expect(await pathExists(workspace)).toBe(false);
    await server.stop();
  });

  test("stops at a Ctrl+C while the runner starts", async ({ halinka }) => {
    await halinka.installSlowDocker();
    const cli = halinka.run(["start", "--port", "0", "--runs-in", "devcontainer"]);
    await cli.expectOutput("listening on");

    cli.interrupt();

    await cli.expectExit(0);
    await cli.expectNoOutputAtClose("runner connected");
  });

  test("stops the server when the runner cannot start", async ({ halinka }) => {
    await halinka.holdRunnerLock();

    const cli = halinka.run(["start", "--port", "0", "--runs-in", "worktree"]);

    await cli.expectExit(1);
    await cli.expectOutput("Another Halinka process runs as the runner");
    expect(await pathExists(join(halinka.home, "server.json"))).toBe(false);
  });

  test("refuses an unknown --runs-in", async ({ halinka }) => {
    const cli = halinka.run(["start", "--runs-in", "cloud"]);
    await cli.expectExit(1);
    await cli.expectOutput('Unknown --runs-in "cloud".');
  });

  test("refuses a port that is not a number", async ({ halinka }) => {
    const cli = halinka.run(["start", "--port", "http"]);
    await cli.expectExit(1);
    await cli.expectOutput('--port must be a number from 0 to 65535. Got "http".');
  });
});
