import { randomBytes } from "node:crypto";

import type { RunnerCapabilities } from "@halinka/protocol";
import { describe, expect, it } from "vitest";

import { createRepositories } from "../db/repositories";
import { credentialPlace, SecretCipher } from "../secrets";
import {
  createConnectedTestServer,
  createTestServer,
  devcontainerConfig,
  devcontainerRunner,
  implementWorkflow,
  recordChanges,
  runningAgentTest,
  setUpTestDb,
  worktreeRunner,
} from "../testing";

const testDb = setUpTestDb();

const key = { preset: "claude-code", variable: "ANTHROPIC_API_KEY" };

const stateOf = async ({ api }: Awaited<ReturnType<typeof createTestServer>>) => {
  const agents = await api.agents.list();
  return agents
    .find(({ preset }) => preset === key.preset)
    ?.credentials.find(({ variable }) => variable === key.variable)?.state;
};

const preset = "claude-code";

const setUp = async () => {
  const server = await createConnectedTestServer(testDb());
  server.files[".halinka/workflows/implement.yml"] = implementWorkflow;
  return server;
};

const startRun = (server: Awaited<ReturnType<typeof setUp>>) =>
  server.api.runs.create({ repoId: 1, workflow: "implement" });

const settingsOf = async ({ api }: Awaited<ReturnType<typeof setUp>>) =>
  (await api.agents.list()).find((agent) => agent.preset === preset);

const request = { preset: "claude-code", runner: "local" };

const finishedTest = async (capabilities: RunnerCapabilities = devcontainerRunner) => {
  const server = await createConnectedTestServer(testDb());
  await server.api.agents.setCredential({ ...key, value: "sk-ant-first-value" });
  await server.api.agents.setCredential({
    ...key,
    variable: "CLAUDE_CODE_OAUTH_TOKEN",
    value: "sk-ant-oat-first-value",
  });
  await server.api.agents.update({ preset: request.preset, version: "1.2.3" });
  await server.api.agents.test(request);
  const { agentTest } = await server.plane.sync({
    held: [],
    capacity: 0,
    capabilities,
    canTest: true,
  });
  await server.plane.finishAgentTest(agentTest!.token, { capabilities: {} });
  const isOld = async () => {
    const agents = await server.api.agents.list();
    return agents.find(({ preset }) => preset === request.preset)?.tests[0]?.isOutdated;
  };
  return { ...server, isOld };
};

describe("GET /api/agents", () => {
  it("lists an agent without settings as enabled, with its keys not set", async () => {
    const server = await createTestServer(testDb());

    expect(await server.api.agents.list()).toContainEqual({
      preset: "codex",
      label: "Codex",
      isEnabled: true,
      defaultVersion: expect.stringMatching(/^\d+\.\d+\.\d+/) as string,
      credentials: [
        { variable: "OPENAI_API_KEY", state: "not_set" },
        { variable: "CODEX_API_KEY", state: "not_set" },
      ],
      tests: [],
    });
  });

  it("shows a stored value as set", async () => {
    const server = await createTestServer(testDb());

    await server.api.agents.setCredential({ ...key, value: "sk-ant-stored-value" });

    expect(await stateOf(server)).toBe("set");
  });

  it("never gives a stored value back", async () => {
    const server = await createTestServer(testDb());

    await server.api.agents.setCredential({ ...key, value: "sk-ant-stored-value" });

    expect(JSON.stringify(await server.api.agents.list())).not.toContain("sk-ant-stored-value");
  });

  it("shows a value of another master key as unreadable", async () => {
    const server = await createTestServer(testDb());
    const other = new SecretCipher(randomBytes(32));
    const place = { ...key, memberId: null };
    await createRepositories(testDb()).agentCredential.save({
      ...place,
      sealed: other.seal(credentialPlace(place), "sk-ant-stored-value"),
    });

    expect(await stateOf(server)).toBe("unreadable");
  });

  it("does not call a test old when nothing changed", async () => {
    const { isOld } = await finishedTest();

    expect(await isOld()).toBe(false);
  });

  it("calls a test old after a new version", async () => {
    const { api, isOld } = await finishedTest();

    await api.agents.update({ preset: request.preset, version: "1.2.4" });

    expect(await isOld()).toBe(true);
  });

  it("calls a test old after a new default model", async () => {
    const { api, isOld } = await finishedTest();

    await api.agents.update({ preset: request.preset, model: "small" });

    expect(await isOld()).toBe(true);
  });

  it("calls a test old after a removed key", async () => {
    const { api, isOld } = await finishedTest();

    await api.agents.deleteCredential(key);

    expect(await isOld()).toBe(true);
  });

  it("hides the test of a revoked runner", async () => {
    const { api, runnerId } = await finishedTest();

    await api.runners.revoke({ id: runnerId });

    const agents = await api.agents.list();
    expect(agents.find(({ preset }) => preset === request.preset)?.tests).toEqual([]);
  });

  it("calls a test old after a new key", async () => {
    const { api, isOld } = await finishedTest();

    await api.agents.setCredential({ ...key, value: "sk-ant-stored-value" });

    expect(await isOld()).toBe(true);
  });

  it("does not call a test of a worktree runner old, which uses neither", async () => {
    const { api, isOld } = await finishedTest(worktreeRunner);

    await api.agents.setCredential({ ...key, value: "sk-ant-stored-value" });

    expect(await isOld()).toBe(false);
  });
});

describe("DELETE /api/agents/{preset}/credentials/{variable}", () => {
  it("removes a stored value", async () => {
    const server = await createTestServer(testDb());
    await server.api.agents.setCredential({ ...key, value: "sk-ant-stored-value" });

    await server.api.agents.deleteCredential(key);

    expect(await stateOf(server)).toBe("not_set");
  });
});

describe("PUT /api/agents/{preset}/credentials/{variable}", () => {
  it("stores a value without the white space around it", async () => {
    const server = await createConnectedTestServer(testDb());
    server.files[".halinka/workflows/implement.yml"] = implementWorkflow;
    server.files[".halinka/config.yml"] = devcontainerConfig;
    await server.api.agents.setCredential({ ...key, value: " sk-ant-stored-value\n" });
    await server.api.runs.create({ repoId: 1, workflow: "implement" });
    const { lease } = await server.claimOne([], "devcontainer");

    expect(await server.plane.readAgentCredentials(lease, key.preset)).toEqual([
      { variable: key.variable, value: "sk-ant-stored-value" },
    ]);
  });

  it("refuses a variable that the preset does not have", async () => {
    const server = await createTestServer(testDb());

    await expect(
      server.api.agents.setCredential({
        preset: "codex",
        variable: "ANTHROPIC_API_KEY",
        value: "sk-ant-stored-value",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.each(["short", "sk with spaces", "sk-ant\nInjected: value", "k".repeat(4097)])(
    "refuses the value %j",
    async (value) => {
      const server = await createTestServer(testDb());

      await expect(server.api.agents.setCredential({ ...key, value })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    },
  );
});

describe("PATCH /api/agents/{preset}", () => {
  it("keeps the other setting at an update", async () => {
    const server = await setUp();
    await server.api.agents.update({ preset, version: "1.2.3" });

    await server.api.agents.update({ preset, isEnabled: false });

    expect(await settingsOf(server)).toMatchObject({ isEnabled: false, version: "1.2.3" });
  });

  it("goes back to the version of the preset", async () => {
    const server = await setUp();
    await server.api.agents.update({ preset, version: "1.2.3" });

    await server.api.agents.update({ preset, version: null });

    expect(await settingsOf(server)).not.toHaveProperty("version");
  });

  it.each(["latest", "1.2", "1.2.3 --ignore-scripts", "1.2.3;id"])(
    "refuses the version %j",
    async (version) => {
      const server = await setUp();

      await expect(server.api.agents.update({ preset, version })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    },
  );

  it("refuses an agent that has no preset", async () => {
    const server = await setUp();

    await expect(
      server.api.agents.update({ preset: "other", isEnabled: false }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("tells a run stream that waits when an agent is disabled", async () => {
    const server = await setUp();
    const { id } = await startRun(server);
    const changes = recordChanges(server.bus, id);

    await server.api.agents.update({ preset, isEnabled: false });

    expect(changes).toContain("state");
  });

  it("accepts an update without settings", async () => {
    const server = await setUp();

    await expect(server.api.agents.update({ preset })).resolves.toEqual({ preset });
  });

  it("accepts a prerelease version", async () => {
    const server = await setUp();

    await server.api.agents.update({ preset, version: "1.2.3-beta.1" });

    expect(await settingsOf(server)).toMatchObject({ version: "1.2.3-beta.1" });
  });

  it("stores the default model", async () => {
    const server = await setUp();

    await server.api.agents.update({ preset, model: "small" });

    expect(await settingsOf(server)).toMatchObject({ model: "small" });
  });

  it("clears the default model", async () => {
    const server = await setUp();
    await server.api.agents.update({ preset, model: "small" });

    await server.api.agents.update({ preset, model: null });

    expect(await settingsOf(server)).not.toHaveProperty("model");
  });

  it.each(["", "  ", "x".repeat(201)])("refuses the default model %j", async (model) => {
    const server = await setUp();

    await expect(server.api.agents.update({ preset, model })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("POST /api/runs", () => {
  it("refuses a new run of a disabled agent", async () => {
    const server = await setUp();
    await server.api.agents.update({ preset, isEnabled: false });

    await expect(startRun(server)).rejects.toThrow(`The agent ${preset} is disabled`);
  });

  it("does not refuse a run of another agent", async () => {
    const server = await setUp();
    await server.api.agents.update({ preset: "codex", isEnabled: false });

    await expect(startRun(server)).resolves.toMatchObject({ status: "queued" });
  });

  it("refuses a new run of a disabled agent on a draining runner", async () => {
    const server = await setUp();
    await server.api.runners.update({ id: server.runnerId, state: "draining" });
    await server.api.agents.update({ preset, isEnabled: false });

    await expect(startRun(server)).rejects.toThrow("is disabled");
  });
});

describe("sync", () => {
  it("gives a runner no queued run of a disabled agent", async () => {
    const server = await setUp();
    await startRun(server);
    await server.api.agents.update({ preset, isEnabled: false });

    await expect(server.claimOne()).rejects.toThrow("No run was claimed");
  });

  it("gives a runner the queued run when the agent is enabled again", async () => {
    const server = await setUp();
    const { id } = await startRun(server);
    await server.api.agents.update({ preset, isEnabled: false });

    await server.api.agents.update({ preset, isEnabled: true });

    await expect(server.claimOne()).resolves.toMatchObject({ lease: { workflowRunId: id } });
  });

  it("keeps a run that started when its agent is disabled", async () => {
    const server = await setUp();
    await startRun(server);
    const claimed = await server.claimOne();
    await server.api.agents.update({ preset, isEnabled: false });

    const { keep } = await server.plane.sync({
      held: [claimed.lease],
      capacity: 0,
      capabilities: worktreeRunner,
    });

    expect(keep).toEqual([claimed.lease.workflowRunId]);
  });

  it("gives the runner the default models in a claim", async () => {
    const server = await setUp();
    await server.api.agents.update({ preset, model: "small" });
    await server.api.agents.update({ preset: "codex", version: "1.2.3" });
    await startRun(server);

    const claimed = await server.claimOne();

    expect(claimed.agentModels).toEqual({ [preset]: "small" });
  });

  it("gives the runner the selected versions in a claim", async () => {
    const server = await setUp();
    await server.api.agents.update({ preset, version: "1.2.3" });
    await server.api.agents.update({ preset: "codex", isEnabled: true });
    await startRun(server);

    const claimed = await server.claimOne();

    expect(claimed.agentVersions).toEqual({ [preset]: "1.2.3" });
  });
});

describe("GET /api/runs/{id}", () => {
  it("gives a queued run of a disabled agent the reason for its wait", async () => {
    const server = await setUp();
    const { id } = await startRun(server);
    await server.api.agents.update({ preset, isEnabled: false });

    expect((await server.api.runs.get({ id })).waitReason).toContain("is disabled");
  });
});

describe("POST /api/agents/{preset}/tests", () => {
  it("wakes the runner", async () => {
    const { api, commands } = await createConnectedTestServer(testDb());

    await api.agents.test(request);

    expect(commands.wake).toHaveBeenCalled();
  });

  it("refuses an agent that does not exist", async () => {
    const { api } = await createConnectedTestServer(testDb());

    await expect(api.agents.test({ ...request, preset: "other" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses a runner that does not exist", async () => {
    const { api } = await createConnectedTestServer(testDb());

    await expect(api.agents.test({ ...request, runner: "other" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses a runner that does not allow the agent", async () => {
    const { api, runnerId } = await createConnectedTestServer(testDb());
    await api.runners.update({ id: runnerId, labels: [], allowedAgents: ["codex"] });

    await expect(api.agents.test(request)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a runner that is not connected", async () => {
    const { api, disconnect } = await createConnectedTestServer(testDb());
    disconnect();

    await expect(api.agents.test(request)).rejects.toMatchObject({ code: "RUNNER_OFFLINE" });
  });

  it("clears the earlier result at a later request", async () => {
    const { api, plane, token, readTest } = await runningAgentTest(testDb());
    await plane.finishAgentTest(token, { error: "Invalid API key" });

    await api.agents.test(request);

    expect(await readTest()).not.toHaveProperty("error");
  });
});
