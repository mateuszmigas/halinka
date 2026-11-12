import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../client";
import {
  createConnectedTestServer,
  createLoginTestServer,
  fakeGitHub,
  hubot,
  logIn,
  octo,
  repoPath,
  setUpTestDb,
  testApiUrl,
} from "../testing";

const testDb = setUpTestDb();

const setUp = () => createLoginTestServer(testDb());

const secondMemberId = async (api: Pick<ApiClient, "members">) => (await api.members.list())[1]!.id;

describe("GET /api/session", () => {
  it("says that a login is required", async () => {
    const { api } = await setUp();

    expect(await api.session()).toEqual({ isLoginRequired: true, serverUrl: expect.any(String) });
  });

  it("gives the logged-in user in the session", async () => {
    const { adminApi } = await setUp();

    const api = await adminApi();

    expect(await api.session()).toEqual({
      isLoginRequired: true,
      serverUrl: testApiUrl,
      user: { login: "octo", role: "admin" },
    });
  });

  it("needs no login on this machine", async () => {
    const { api } = await createConnectedTestServer(testDb());

    expect(await api.session()).toMatchObject({
      isLoginRequired: false,
      user: { login: "local", role: "admin" },
    });
  });
});

describe("POST /api/runs", () => {
  it("lets a Member start a run", async () => {
    const { memberApi } = await setUp();

    const api = await memberApi();

    expect(await api.runs.create({ repoId: 1, workflow: "build" })).toMatchObject({ id: 1 });
  });

  it("refuses a write without JSON", async () => {
    const { app } = await setUp();

    const answer = await app.request(`${testApiUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });

    expect(answer.status).toBe(415);
  });
});

describe("POST /api/inbox/{id}/resolve", () => {
  it("names the member as the author of a decision", async () => {
    const { api, memberCookie, setApiCookie, waitForApproval } = await setUp();
    setApiCookie(await memberCookie());
    await waitForApproval();
    const [item] = await api.inbox.list();

    await api.inbox.resolve({ id: item!.id, decision: "approve" });

    expect((await api.inbox.list()).find(({ id }) => id === item!.id)).toBeUndefined();
    expect((await api.runs.get({ id: item!.workflowRunId })).inboxItems).toMatchObject([
      { resolvedBy: "hubot" },
    ]);
  });
});

describe("POST /api/repos/init", () => {
  it("uses the public URL for the server of a repo setup", async () => {
    const server = await createConnectedTestServer(testDb(), {
      hasAuth: true,
      isRemoteRunner: true,
    });
    server.setApiCookie((await logIn(server.app, testApiUrl, octo)).cookie);

    await server.api.repos.init({ runnerId: server.runnerId, path: "/code/other" }).catch(() => {});

    expect(server.commands.setUpRepo).toHaveBeenCalledWith(
      expect.objectContaining({ server: testApiUrl }),
    );
  });
});

describe("POST /api/repos", () => {
  it("lets an Admin register a repo", async () => {
    const { adminApi, runnerId } = await setUp();

    const api = await adminApi();

    expect(await api.repos.register({ runnerId, path: repoPath })).toMatchObject({ id: 1 });
  });
});

describe("GET /api/health", () => {
  it("accepts another host than this machine", async () => {
    const { app } = await setUp();

    expect((await app.request("https://halinka.example.com/api/health")).status).toBe(200);
  });
});

describe("POST /api/members", () => {
  it("gives the added member", async () => {
    const { adminApi } = await setUp();
    const api = await adminApi();

    const added = await api.members.create({ login: "hubot", role: "member" });

    expect(added).toMatchObject({ login: "hubot", role: "member" });
  });

  it("refuses a GitHub user that does not exist", async () => {
    const { adminApi } = await setUp();
    const api = await adminApi();

    await expect(api.members.create({ login: "nobody", role: "member" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "There is no GitHub user nobody",
    });
  });

  it("refuses an organization", async () => {
    const { adminApi } = await setUp();
    const api = await adminApi();
    fakeGitHub(octo, [{ ...hubot, login: "acme", type: "Organization" }]);

    await expect(api.members.create({ login: "acme", role: "member" })).rejects.toMatchObject({
      message: "acme is not a GitHub user",
    });
  });

  it("says that GitHub did not answer", async () => {
    const { adminApi } = await setUp();
    const api = await adminApi();
    vi.stubGlobal("fetch", async () => {
      throw new Error("no network");
    });

    await expect(api.members.create({ login: "hubot", role: "member" })).rejects.toMatchObject({
      message: "GitHub did not answer. Try again.",
    });
  });

  it("gives the status of a failed request", async () => {
    const { adminApi } = await setUp();
    const api = await adminApi();
    vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));

    await expect(api.members.create({ login: "hubot", role: "member" })).rejects.toMatchObject({
      message: "GitHub answered 500",
    });
  });

  it("refuses a member that exists", async () => {
    const { adminApi } = await setUp();
    const api = await adminApi();
    await api.members.create({ login: "hubot", role: "member" });

    await expect(api.members.create({ login: "hubot", role: "member" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("GET /api/members", () => {
  it("lists the members", async () => {
    const { adminApi } = await setUp();
    const api = await adminApi();
    await api.members.create({ login: "hubot", role: "member" });

    expect(await api.members.list()).toMatchObject([{ login: "octo" }, { login: "hubot" }]);
  });
});

describe("DELETE /api/members/{id}", () => {
  it("ends the session of a removed member", async () => {
    const { adminApi, memberApi } = await setUp();
    const member = await memberApi();
    const admin = await adminApi();

    await admin.members.delete({ id: await secondMemberId(admin) });

    await expect(member.runs.list({})).rejects.toMatchObject({ status: 401 });
  });

  it("ends the run stream of a removed member at its next change", async () => {
    const { adminApi, memberApi } = await setUp();
    const member = await memberApi();
    const admin = await adminApi();
    const { id } = await member.runs.create({ repoId: 1, workflow: "build" });
    const stream = await member.runs.watch({ id });
    await stream.next();

    await admin.members.delete({ id: await secondMemberId(admin) });
    await admin.runs.cancel({ id });

    await expect(stream.next()).rejects.toMatchObject({ status: 401 });
  });

  it("refuses to remove the last Admin", async () => {
    const { adminApi } = await setUp();
    const api = await adminApi();
    const { id } = (await api.members.list())[0]!;

    await expect(api.members.delete({ id })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("removes an Admin while another Admin exists", async () => {
    const { adminApi } = await setUp();
    const api = await adminApi();
    await api.members.create({ login: "hubot", role: "admin" });

    await api.members.delete({ id: await secondMemberId(api) });

    expect(await api.members.list()).toMatchObject([{ login: "octo" }]);
  });

  it("answers NOT_FOUND for a member that does not exist", async () => {
    const { adminApi } = await setUp();
    const api = await adminApi();

    await expect(api.members.delete({ id: 99 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("GET /api/auth/callback/github", () => {
  it("refuses a login of a removed member", async () => {
    const { adminApi, memberApi, app } = await setUp();
    await memberApi();
    const admin = await adminApi();
    await admin.members.delete({ id: await secondMemberId(admin) });

    const { cookie } = await logIn(app, testApiUrl, hubot);

    expect(cookie).toBe("");
  });
});

describe("PATCH /api/runners/{id}", () => {
  it("acts as an Admin with no login on this machine", async () => {
    const { api, runnerId } = await createConnectedTestServer(testDb());

    expect(await api.runners.update({ id: runnerId, labels: [] })).toMatchObject({ id: runnerId });
  });
});
