import { describe, expect, it } from "vitest";

import { createApiClient } from "../client";
import { createConnectedTestServer, hubot, logIn, octo, setUpTestDb, testApiUrl } from "../testing";

const testDb = setUpTestDb();

const setUp = async () => {
  const server = await createConnectedTestServer(testDb(), { hasAuth: true });
  const { app } = server;
  const apiWith = (headers: Record<string, string>) =>
    createApiClient(testApiUrl, {
      fetch: async (request) => {
        for (const [name, value] of Object.entries(headers)) request.headers.set(name, value);
        return app.fetch(request);
      },
    });
  const { cookie } = await logIn(app, testApiUrl, octo);
  const admin = apiWith({ cookie });
  const approvedToken = async () => {
    const { deviceCode, userCode } = await server.api.cliLogin.start();
    await admin.cliLogin.approve({ userCode });
    const answer = await server.api.cliLogin.exchange({ deviceCode });
    if (answer.status !== "approved") throw new Error("Not approved");
    return answer.token;
  };
  const tokenApi = (token: string) => apiWith({ authorization: `Bearer ${token}` });
  return { ...server, admin, approvedToken, tokenApi };
};

describe("POST /api/cli-logins/exchange", () => {
  it("answers pending before the approval", async () => {
    const { api } = await setUp();
    const { deviceCode } = await api.cliLogin.start();

    expect(await api.cliLogin.exchange({ deviceCode })).toEqual({ status: "pending" });
  });

  it("gives a token that acts as the member who approved", async () => {
    const { approvedToken, tokenApi } = await setUp();

    const api = tokenApi(await approvedToken());

    expect(await api.session()).toMatchObject({ user: { login: "octo", role: "admin" } });
  });

  it("gives the token once", async () => {
    const { api, admin } = await setUp();
    const { deviceCode, userCode } = await api.cliLogin.start();
    await admin.cliLogin.approve({ userCode });
    await api.cliLogin.exchange({ deviceCode });

    await expect(api.cliLogin.exchange({ deviceCode })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("POST /api/cli-logins/{userCode}/approve", () => {
  it("refuses an approval without a login", async () => {
    const { api } = await setUp();
    const { userCode } = await api.cliLogin.start();

    await expect(api.cliLogin.approve({ userCode })).rejects.toMatchObject({ status: 401 });
  });

  it("refuses a code that does not exist", async () => {
    const { admin } = await setUp();

    await expect(admin.cliLogin.approve({ userCode: "NOPE-NOPE" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses a second approval of one code", async () => {
    const { api, admin } = await setUp();
    const { userCode } = await api.cliLogin.start();
    await admin.cliLogin.approve({ userCode });

    await expect(admin.cliLogin.approve({ userCode })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses an approval with a token", async () => {
    const { api, approvedToken, tokenApi } = await setUp();
    const token = tokenApi(await approvedToken());
    const { userCode } = await api.cliLogin.start();

    await expect(token.cliLogin.approve({ userCode })).rejects.toMatchObject({ status: 403 });
  });
});

describe("GET /api/runs", () => {
  it("refuses a CLI token that is not known", async () => {
    const { tokenApi } = await setUp();

    await expect(tokenApi("not-a-token").runs.list({})).rejects.toMatchObject({ status: 401 });
  });
});

describe("DELETE /api/members/{id}", () => {
  it("ends the CLI token of a removed member", async () => {
    const { admin, api, app, tokenApi } = await setUp();
    const { id } = await admin.members.create({ login: "hubot", role: "member" });
    const { cookie } = await logIn(app, testApiUrl, hubot);
    const { deviceCode, userCode } = await api.cliLogin.start();
    const member = createApiClient(testApiUrl, {
      fetch: async (request) => {
        request.headers.set("cookie", cookie);
        return app.fetch(request);
      },
    });
    await member.cliLogin.approve({ userCode });
    const answer = await api.cliLogin.exchange({ deviceCode });
    const memberToken = answer.status === "approved" ? answer.token : "";
    await admin.members.delete({ id });

    await expect(tokenApi(memberToken).runs.list({})).rejects.toMatchObject({ status: 401 });
  });
});

describe("GET /api/cli-logins", () => {
  it("lists the tokens of the member", async () => {
    const { admin, approvedToken } = await setUp();
    await approvedToken();

    expect(await admin.cliLogin.list()).toHaveLength(1);
  });

  it("does not list a request that has no token yet", async () => {
    const { admin, api } = await setUp();
    const { userCode } = await api.cliLogin.start();
    await admin.cliLogin.approve({ userCode });

    expect(await admin.cliLogin.list()).toEqual([]);
  });

  it("refuses to list the tokens with a token", async () => {
    const { approvedToken, tokenApi } = await setUp();
    const api = tokenApi(await approvedToken());

    await expect(api.cliLogin.list()).rejects.toMatchObject({ status: 403 });
  });
});

describe("DELETE /api/cli-logins/{id}", () => {
  it("ends a token from the portal", async () => {
    const { admin, approvedToken, tokenApi } = await setUp();
    const api = tokenApi(await approvedToken());
    const [login] = await admin.cliLogin.list();

    await admin.cliLogin.end({ id: login!.id });

    await expect(api.runs.list({})).rejects.toMatchObject({ status: 401 });
  });

  it("ends the token of the last Admin", async () => {
    const { admin, approvedToken, tokenApi } = await setUp();
    const api = tokenApi(await approvedToken());
    const [login] = await admin.cliLogin.list();

    await admin.cliLogin.end({ id: login!.id });

    await expect(api.session()).resolves.not.toHaveProperty("user");
  });

  it("refuses to end a token of another member", async () => {
    const { admin, app, approvedToken } = await setUp();
    await approvedToken();
    const [login] = await admin.cliLogin.list();
    await admin.members.create({ login: "hubot", role: "member" });
    const { cookie } = await logIn(app, testApiUrl, hubot);
    const member = createApiClient(testApiUrl, {
      fetch: async (request) => {
        request.headers.set("cookie", cookie);
        return app.fetch(request);
      },
    });

    await expect(member.cliLogin.end({ id: login!.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses to end a token with a token", async () => {
    const { admin, approvedToken, tokenApi } = await setUp();
    const api = tokenApi(await approvedToken());
    const [login] = await admin.cliLogin.list();

    await expect(api.cliLogin.end({ id: login!.id })).rejects.toMatchObject({ status: 403 });
  });
});

describe("POST /api/cli-logins/logout", () => {
  it("ends the token of the request at a logout", async () => {
    const { approvedToken, tokenApi } = await setUp();
    const api = tokenApi(await approvedToken());

    await api.cliLogin.logout();

    await expect(api.runs.list({})).rejects.toMatchObject({ status: 401 });
  });

  it("keeps the other tokens of the member at a logout", async () => {
    const { approvedToken, tokenApi } = await setUp();
    const first = tokenApi(await approvedToken());
    const second = tokenApi(await approvedToken());

    await first.cliLogin.logout();

    await expect(second.runs.list({})).resolves.toBeDefined();
  });

  it("refuses a logout without a token", async () => {
    const { admin } = await setUp();

    await expect(admin.cliLogin.logout()).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("POST /api/cli-logins", () => {
  it("refuses a login on a server without a login", async () => {
    const { api } = await createConnectedTestServer(testDb());

    await expect(api.cliLogin.start()).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
