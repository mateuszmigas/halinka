import { describe, expect, it } from "vitest";

import { registerTestRunner, setUpTestDb, testKeyOf } from "../../testing";
import { createRepositories, inTransaction } from "./createRepositories";

const testDb = setUpTestDb();

const runnerWithPendingKey = async () => {
  const { id } = await registerTestRunner(testDb(), "host");
  await createRepositories(testDb()).runnerKey.create(id, "new-key", "pending");
  return id;
};

const keyStates = async (...keys: string[]) => {
  const { runner } = createRepositories(testDb());
  return Promise.all(keys.map(async (key) => (await runner.findByPublicKey(key))?.keyState));
};

const promotePendingKey = async () => {
  const id = await runnerWithPendingKey();
  await inTransaction(testDb(), async ({ runner, runnerKey }) => {
    await runner.lockById(id);
    await runnerKey.promote(id, "new-key");
  });
};

describe("RunnerKeyRepository", () => {
  it("makes the pending key current", async () => {
    await promotePendingKey();

    expect(await keyStates("new-key")).toEqual(["current"]);
  });

  it("retires the old key at a promotion", async () => {
    await promotePendingKey();

    expect(await keyStates(testKeyOf("host"))).toEqual(["retired"]);
  });

  it("retires the pending key that a newer key replaces", async () => {
    const id = await runnerWithPendingKey();

    await inTransaction(testDb(), ({ runnerKey }) => runnerKey.replacePending(id, "newer-key"));

    expect(await keyStates("new-key", "newer-key")).toEqual(["retired", "pending"]);
  });

  it("keeps the current key when a newer key replaces the pending key", async () => {
    const id = await runnerWithPendingKey();

    await inTransaction(testDb(), ({ runnerKey }) => runnerKey.replacePending(id, "newer-key"));

    expect(await keyStates(testKeyOf("host"))).toEqual(["current"]);
  });

  it("promotes no key that is not pending", async () => {
    const id = await runnerWithPendingKey();
    await inTransaction(testDb(), ({ runnerKey }) => runnerKey.replacePending(id, "newer-key"));

    const promoted = await inTransaction(testDb(), async ({ runner, runnerKey }) => {
      await runner.lockById(id);
      return runnerKey.promote(id, "new-key");
    });

    expect(promoted).toBe(false);
  });
});
