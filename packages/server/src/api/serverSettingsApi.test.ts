import { describe, expect, it } from "vitest";

import { createLoginTestServer, createTestServer, setUpTestDb } from "../testing";

const testDb = setUpTestDb();

const memberApi = async () => (await createLoginTestServer(testDb())).memberApi();

describe("GET /api/server-settings", () => {
  it("checks for updates on a new server", async () => {
    const { api } = await createTestServer(testDb());

    expect(await api.serverSettings.get()).toEqual({ isUpdateCheckOn: true });
  });

  it("gives the changed settings", async () => {
    const { api } = await createTestServer(testDb());
    await api.serverSettings.update({ isUpdateCheckOn: false });

    expect(await api.serverSettings.get()).toEqual({ isUpdateCheckOn: false });
  });

  it("refuses a Member", async () => {
    const member = await memberApi();

    await expect(member.serverSettings.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("PATCH /api/server-settings", () => {
  it("answers the changed settings", async () => {
    const { api } = await createTestServer(testDb());

    const answer = await api.serverSettings.update({ isUpdateCheckOn: false });

    expect(answer).toEqual({ isUpdateCheckOn: false });
  });

  it("keeps a setting that the update does not give", async () => {
    const { api } = await createTestServer(testDb());
    await api.serverSettings.update({ isUpdateCheckOn: false });

    expect(await api.serverSettings.update({})).toEqual({ isUpdateCheckOn: false });
  });

  it("refuses a Member", async () => {
    const member = await memberApi();

    await expect(member.serverSettings.update({ isUpdateCheckOn: false })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
