import { describe, expect, it } from "vitest";

import { registerTestRunner, setUpTestDb } from "../../testing";
import { createRepositories } from "./createRepositories";

const testDb = setUpTestDb();

const setUpKeys = async () => {
  const { id } = await registerTestRunner(testDb(), "host");
  const { runner, runnerKey } = createRepositories(testDb());
  await runnerKey.create(id, "new-key", "pending");
  return { runner, id };
};

describe("RunnerRepository", () => {
  it("creates no runner when another runner has the name", async () => {
    const { runner } = createRepositories(testDb());
    await runner.create({ name: "host" });

    expect(await runner.create({ name: "host" })).toBeUndefined();
  });

  it("finds a runner by its key, with the state of the key", async () => {
    const { runner, runnerKey } = createRepositories(testDb());
    const created = await runner.create({ name: "host" });
    await runnerKey.create(created?.id ?? 0, "host-key", "current");

    expect(await runner.findByPublicKey("host-key")).toEqual({ ...created, keyState: "current" });
  });

  it("lists each runner with its current key", async () => {
    const { runner, runnerKey } = createRepositories(testDb());
    const created = await runner.create({ name: "host" });
    await runnerKey.create(created?.id ?? 0, "old-key", "current");
    await runnerKey.create(created?.id ?? 0, "new-key", "pending");

    expect(await runner.list()).toMatchObject([{ name: "host", publicKey: "old-key" }]);
  });

  it("gives the runner authority with its current key", async () => {
    const { runner, id } = await setUpKeys();

    expect(await runner.hasAuthority(id, "host-key")).toBe(true);
  });

  it("gives the runner no authority with its pending key", async () => {
    const { runner, id } = await setUpKeys();

    expect(await runner.hasAuthority(id, "new-key")).toBe(false);
  });

  it("gives a revoked runner no authority", async () => {
    const { runner, id } = await setUpKeys();

    await runner.revoke(id);

    expect(await runner.hasAuthority(id, "host-key")).toBe(false);
  });
});
