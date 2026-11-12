import { describe, expect, it } from "vitest";

import type { ApiClient } from "../client";
import { createRepositories } from "../db/repositories";
import { credentialPlace } from "../secrets";
import {
  createConnectedTestServer,
  createLoginTestServer,
  devcontainerConfig,
  devcontainerRunner,
  implementWorkflow,
  setUpTestDb,
  syncRunner,
  testCipher,
  worktreeRunner,
} from "../testing";

const testDb = setUpTestDb();

const key = { preset: "claude-code", variable: "ANTHROPIC_API_KEY" };
const otherVariable = { preset: "claude-code", variable: "CLAUDE_CODE_OAUTH_TOKEN" };
const teamValue = { ...key, value: "sk-ant-team-value" };
const ownValue = { ...key, value: "sk-ant-own-value" };

const agentOf = async (api: Pick<ApiClient, "agents">) => {
  const agents = await api.agents.list();
  return agents.find(({ preset }) => preset === key.preset);
};

const stateIn = (credentials: { variable: string; state: string }[] | undefined) =>
  credentials?.find(({ variable }) => variable === key.variable)?.state;

const setUp = async () => {
  const server = await createLoginTestServer(testDb());
  server.files[".halinka/workflows/implement.yml"] = implementWorkflow;
  server.files[".halinka/config.yml"] = devcontainerConfig;
  const admin = await server.adminApi();
  const member = await server.memberApi();
  const memberId = async () => {
    const members = await admin.members.list();
    const found = members.find(({ login }) => login === "hubot");
    if (!found) throw new Error("The Member is missing");
    return found.id;
  };
  const claimRunOf = async (author: Pick<ApiClient, "runs">) => {
    await author.runs.create({ repoId: 1, workflow: "implement" });
    return server.claimOne([], "devcontainer");
  };
  return { ...server, admin, member, memberId, claimRunOf };
};

const request = { preset: key.preset, runner: "local" };

const containerServer = async () => {
  const server = await setUp();
  await syncRunner(server.plane, devcontainerRunner, { canTest: false });
  return server;
};

const claimedOwnTest = async () => {
  const server = await containerServer();
  await server.member.agents.setMyCredential(ownValue);
  await server.member.agents.testMine(request);
  const { agentTest } = await syncRunner(server.plane, devcontainerRunner);
  if (!agentTest) throw new Error("No test was claimed");
  return { ...server, token: agentTest.token };
};

describe("GET /api/agents", () => {
  it("shows a key to its owner", async () => {
    const { member } = await setUp();

    await member.agents.setMyCredential(ownValue);

    expect(stateIn((await agentOf(member))?.mine?.credentials)).toBe("set");
  });

  it("does not show a key of a person as a key of the team", async () => {
    const { member } = await setUp();

    await member.agents.setMyCredential(ownValue);

    expect(stateIn((await agentOf(member))?.credentials)).toBe("not_set");
  });

  it("does not show a key to another person", async () => {
    const { admin, member } = await setUp();

    await member.agents.setMyCredential(ownValue);

    expect(stateIn((await agentOf(admin))?.mine?.credentials)).toBe("not_set");
  });

  it("does not open a sealed value of a person in the row of the team", async () => {
    const { member, memberId } = await setUp();
    const place = { ...key, memberId: await memberId() };

    await createRepositories(testDb()).agentCredential.save({
      ...key,
      memberId: null,
      sealed: testCipher.seal(credentialPlace(place), ownValue.value),
    });

    expect(stateIn((await agentOf(member))?.credentials)).toBe("unreadable");
  });

  it("does not open a sealed value of a person in the row of another person", async () => {
    const { admin, member, memberId } = await setUp();
    const adminId = (await admin.members.list()).find(({ login }) => login === "octo")?.id ?? null;

    await createRepositories(testDb()).agentCredential.save({
      ...key,
      memberId: await memberId(),
      sealed: testCipher.seal(credentialPlace({ ...key, memberId: adminId }), ownValue.value),
    });

    expect(stateIn((await agentOf(member))?.mine?.credentials)).toBe("unreadable");
  });

  it("opens a key of the team that an earlier version sealed", async () => {
    const { admin } = await setUp();

    await createRepositories(testDb()).agentCredential.save({
      ...key,
      memberId: null,
      sealed: testCipher.seal(`agent-credential:${key.preset}:${key.variable}`, teamValue.value),
    });

    expect(stateIn((await agentOf(admin))?.credentials)).toBe("set");
  });

  it("calls the test old after a new key of the person", async () => {
    const { member, plane, token } = await claimedOwnTest();
    await plane.finishAgentTest(token, { capabilities: {} });

    await member.agents.setMyCredential({ ...key, value: "sk-ant-second-value" });

    expect((await agentOf(member))?.mine?.tests).toMatchObject([{ isOutdated: true }]);
  });

  it("does not call the test old after a new key of the team", async () => {
    const { admin, member, plane, token } = await claimedOwnTest();
    await plane.finishAgentTest(token, { capabilities: {} });

    await admin.agents.setCredential(teamValue);

    expect((await agentOf(member))?.mine?.tests).toMatchObject([{ isOutdated: false }]);
  });
});

describe("DELETE /api/agents/{preset}/my-credentials/{variable}", () => {
  it("removes only the key of the caller", async () => {
    const { admin, member } = await setUp();
    await admin.agents.setCredential(teamValue);
    await member.agents.setMyCredential(ownValue);

    await member.agents.deleteMyCredential(key);

    const agent = await agentOf(member);
    expect(stateIn(agent?.mine?.credentials)).toBe("not_set");
    expect(stateIn(agent?.credentials)).toBe("set");
  });
});

describe("DELETE /api/agents/{preset}/credentials/{variable}", () => {
  it("keeps the key of a person when an Admin removes the key of the team", async () => {
    const { admin, member } = await setUp();
    await admin.agents.setCredential(teamValue);
    await member.agents.setMyCredential(ownValue);

    await admin.agents.deleteCredential(key);

    expect(stateIn((await agentOf(member))?.mine?.credentials)).toBe("set");
  });
});

describe("PUT /api/agents/{preset}/my-credentials/{variable}", () => {
  it("refuses the keys of a person on a server without a login", async () => {
    const { api } = await createConnectedTestServer(testDb());

    await expect(api.agents.setMyCredential(ownValue)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("readAgentCredentials", () => {
  it("gives the key of the author in place of the key of the team", async () => {
    const { admin, member, plane, claimRunOf } = await setUp();
    await admin.agents.setCredential(teamValue);
    await member.agents.setMyCredential(ownValue);

    const { lease } = await claimRunOf(member);

    expect(await plane.readAgentCredentials(lease, key.preset)).toEqual([
      { variable: key.variable, value: ownValue.value },
    ]);
  });

  it("gives a changed key of the author at the next read", async () => {
    const { member, plane, claimRunOf } = await setUp();
    await member.agents.setMyCredential(ownValue);
    const { lease } = await claimRunOf(member);

    await member.agents.setMyCredential({ ...key, value: "sk-ant-second-value" });

    expect(await plane.readAgentCredentials(lease, key.preset)).toEqual([
      { variable: key.variable, value: "sk-ant-second-value" },
    ]);
  });

  it("gives the key of the author after a message of another person", async () => {
    const { admin, member, plane, claimRunOf } = await setUp();
    await admin.agents.setCredential(teamValue);
    await member.agents.setMyCredential(ownValue);
    const { lease } = await claimRunOf(member);
    const stepRunId = await plane.startStep(lease, "implement");
    await plane.startAttempt(lease, stepRunId);

    await admin.runs.sendMessage({ id: lease.workflowRunId, stepRunId, text: "Look again" });

    expect(await plane.readAgentCredentials(lease, key.preset)).toEqual([
      { variable: key.variable, value: ownValue.value },
    ]);
  });

  it("gives no value of the team next to a key of the author", async () => {
    const { admin, member, plane, claimRunOf } = await setUp();
    await admin.agents.setCredential({ ...otherVariable, value: "sk-ant-oat-team-value" });
    await member.agents.setMyCredential(ownValue);

    const { lease } = await claimRunOf(member);

    expect(await plane.readAgentCredentials(lease, key.preset)).toEqual([
      { variable: key.variable, value: ownValue.value },
    ]);
  });

  it("gives the key of the team to an author without a key", async () => {
    const { admin, member, plane, claimRunOf } = await setUp();
    await admin.agents.setCredential(teamValue);

    const { lease } = await claimRunOf(member);

    expect(await plane.readAgentCredentials(lease, key.preset)).toEqual([
      { variable: key.variable, value: teamValue.value },
    ]);
  });

  it("does not give the key of another person", async () => {
    const { admin, member, plane, claimRunOf } = await setUp();
    await member.agents.setMyCredential(ownValue);

    const { lease } = await claimRunOf(admin);

    expect(await plane.readAgentCredentials(lease, key.preset)).toEqual([]);
  });

  it("fails on a key of the author that does not open, with a key of the team", async () => {
    const { admin, member, memberId, plane, claimRunOf } = await setUp();
    await admin.agents.setCredential(teamValue);
    await createRepositories(testDb()).agentCredential.save({
      ...key,
      memberId: await memberId(),
      sealed: testCipher.seal(credentialPlace({ ...key, memberId: null }), ownValue.value),
    });

    const { lease } = await claimRunOf(member);

    await expect(plane.readAgentCredentials(lease, key.preset)).rejects.toThrow(
      "Enter the value again",
    );
  });

  it("gives the key of the team after the removal of the author", async () => {
    const { admin, member, memberId, plane, claimRunOf } = await setUp();
    await admin.agents.setCredential(teamValue);
    await member.agents.setMyCredential(ownValue);
    const { lease } = await claimRunOf(member);

    await admin.members.delete({ id: await memberId() });

    expect(await plane.readAgentCredentials(lease, key.preset)).toEqual([
      { variable: key.variable, value: teamValue.value },
    ]);
  });
});

describe("POST /api/agents/{preset}/my-tests", () => {
  it("refuses a person without a key", async () => {
    const { member } = await containerServer();

    await expect(member.agents.testMine(request)).rejects.toThrow("Store your key");
  });

  it("refuses a worktree runner", async () => {
    const server = await setUp();
    await syncRunner(server.plane, worktreeRunner, { canTest: false });
    await server.member.agents.setMyCredential(ownValue);

    await expect(server.member.agents.testMine(request)).rejects.toThrow("has no container");
  });
});

describe("sync", () => {
  it("fails a test of the key of a person that a worktree process finds after a restart of the runner", async () => {
    const server = await containerServer();
    await server.member.agents.setMyCredential(ownValue);
    await server.member.agents.testMine(request);

    const { agentTest } = await syncRunner(server.plane, worktreeRunner);

    expect(agentTest).toBeUndefined();
    expect((await agentOf(server.member))?.mine?.tests).toMatchObject([{ status: "failed" }]);
  });

  it("gives a test of the team before an earlier test of a person", async () => {
    const server = await containerServer();
    await server.member.agents.setMyCredential(ownValue);
    await server.member.agents.testMine(request);
    await server.admin.agents.test(request);

    await syncRunner(server.plane, devcontainerRunner);

    const agent = await agentOf(server.member);
    expect(agent?.tests).toMatchObject([{ status: "running" }]);
    expect(agent?.mine?.tests).toMatchObject([{ status: "requested" }]);
  });
});

describe("readTestCredentials", () => {
  it("gives the runner only the key of the person", async () => {
    const { admin, plane, token } = await claimedOwnTest();
    await admin.agents.setCredential(teamValue);

    expect(await plane.readTestCredentials(token)).toEqual([
      { variable: key.variable, value: ownValue.value },
    ]);
  });

  it("refuses the read after the removal of the key", async () => {
    const { member, plane, token } = await claimedOwnTest();

    await member.agents.deleteMyCredential(key);

    await expect(plane.readTestCredentials(token)).rejects.toThrow("is gone");
  });

  it("refuses the read after the removal of the person", async () => {
    const { admin, memberId, plane, token } = await claimedOwnTest();

    await admin.members.delete({ id: await memberId() });

    await expect(plane.readTestCredentials(token)).rejects.toThrow("The test ended");
  });
});

describe("POST /api/agents/{preset}/tests", () => {
  it("keeps the test of the team next to the test of a person", async () => {
    const { admin, member } = await claimedOwnTest();

    await admin.agents.test(request);

    expect((await agentOf(member))?.mine?.tests).toMatchObject([{ status: "running" }]);
    expect((await agentOf(member))?.tests).toMatchObject([{ status: "requested" }]);
  });
});
