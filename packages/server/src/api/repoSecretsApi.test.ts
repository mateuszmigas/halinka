import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createRepositories } from "../db/repositories";
import { repoSecretPlace, SecretCipher } from "../secrets";
import { createConnectedTestServer, setUpTestDb } from "../testing";

const testDb = setUpTestDb();

const value = "npm_made_up_value";

const withRepo = () => createConnectedTestServer(testDb());

const saveOtherKey = (name = "NPM_TOKEN") =>
  createRepositories(testDb()).repoSecret.save({
    repoId: 1,
    name,
    sealed: new SecretCipher(randomBytes(32)).seal(repoSecretPlace(1, name), value),
  });

describe("GET /api/repos/{id}/secrets", () => {
  it("lists the name of a stored secret, and never its value", async () => {
    const { api } = await withRepo();

    await api.repos.setSecret({ id: 1, name: "NPM_TOKEN", value });

    expect(await api.repos.secrets({ id: 1 })).toEqual([{ name: "NPM_TOKEN", isReadable: true }]);
  });

  it("shows a value of another master key as not readable", async () => {
    const { api } = await withRepo();
    await saveOtherKey();

    expect(await api.repos.secrets({ id: 1 })).toEqual([{ name: "NPM_TOKEN", isReadable: false }]);
  });

  it("does not open a sealed value under another name", async () => {
    const { api } = await withRepo();
    const repoSecret = createRepositories(testDb()).repoSecret;
    await api.repos.setSecret({ id: 1, name: "NPM_TOKEN", value });
    const [row] = await repoSecret.listByRepo(1);

    await repoSecret.save({ repoId: 1, name: "OTHER", sealed: row?.sealed ?? "" });

    expect(await api.repos.secrets({ id: 1 })).toContainEqual({ name: "OTHER", isReadable: false });
  });
});

describe("PUT /api/repos/{id}/secrets/{name}", () => {
  it("stores the value sealed", async () => {
    const { api } = await withRepo();

    await api.repos.setSecret({ id: 1, name: "NPM_TOKEN", value });

    const [row] = await createRepositories(testDb()).repoSecret.listByRepo(1);
    expect(row?.sealed).not.toContain(value);
  });

  it("makes a value readable again with a new value", async () => {
    const { api } = await withRepo();
    await saveOtherKey();

    await api.repos.setSecret({ id: 1, name: "NPM_TOKEN", value });

    expect(await api.repos.secrets({ id: 1 })).toEqual([{ name: "NPM_TOKEN", isReadable: true }]);
  });

  it("refuses a name that is not an environment name", async () => {
    const { api } = await withRepo();

    await expect(api.repos.setSecret({ id: 1, name: "npm-token", value })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("refuses a value that the runner cannot mask", async () => {
    const { api } = await withRepo();

    await expect(
      api.repos.setSecret({ id: 1, name: "NPM_TOKEN", value: "short" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a secret of a repo that does not exist", async () => {
    const { api } = await withRepo();

    await expect(api.repos.setSecret({ id: 9, name: "NPM_TOKEN", value })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("DELETE /api/repos/{id}/secrets/{name}", () => {
  it("removes a secret", async () => {
    const { api } = await withRepo();
    await api.repos.setSecret({ id: 1, name: "NPM_TOKEN", value });

    await api.repos.deleteSecret({ id: 1, name: "NPM_TOKEN" });

    expect(await api.repos.secrets({ id: 1 })).toEqual([]);
  });
});
