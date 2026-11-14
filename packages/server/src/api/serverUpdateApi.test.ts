import { describe, expect, it } from "vitest";

import { createLoginTestServer, createTestServer, setUpTestDb, stubNpmRegistry } from "../testing";

const testDb = setUpTestDb();

const setUp = async () => {
  const server = await createTestServer(testDb(), { command: "server" });
  return { ...server, updateCheck: server.updateCheck! };
};

describe("GET /api/server-update", () => {
  it("gives no update without an update check", async () => {
    const { api } = await createTestServer(testDb());

    expect(await api.serverUpdate.get()).toEqual({ currentVersion: "0.0.1" });
  });

  it("gives a newer version from the npm registry", async () => {
    stubNpmRegistry();
    const { api, updateCheck } = await setUp();

    await updateCheck.check();

    expect(await api.serverUpdate.get()).toEqual({
      currentVersion: "0.0.1",
      update: { latestVersion: "9.0.0", isProtocolChange: false, command: "server" },
    });
  });

  it("gives no update after an Admin turns off the update check", async () => {
    stubNpmRegistry();
    const { api, updateCheck } = await setUp();
    await updateCheck.check();

    await api.serverSettings.update({ isUpdateCheckOn: false });

    expect(await api.serverUpdate.get()).toEqual({ currentVersion: "0.0.1" });
  });

  it("refuses a Member", async () => {
    const member = await (await createLoginTestServer(testDb())).memberApi();

    await expect(member.serverUpdate.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
