import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it } from "vitest";

import { loadOrCreateRunnerKey, readRunnerKey, runnerKeyPath } from "./runnerKey";

describe("loadOrCreateRunnerKey", () => {
  it("creates a key named after the host", async () => {
    const key = await loadOrCreateRunnerKey(await tempFolder());

    expect(key.name).toBe(hostname());
  });

  it("creates the file that only its owner can read", async () => {
    const home = await tempFolder();

    await loadOrCreateRunnerKey(home);

    expect((await stat(runnerKeyPath(home))).mode & 0o777).toBe(0o600);
  });

  it("creates the home folder when it does not exist", async () => {
    const home = join(await tempFolder(), "home");

    await loadOrCreateRunnerKey(home);

    expect(JSON.parse(await readFile(runnerKeyPath(home), "utf8"))).toHaveProperty("publicKey");
  });

  it("gives the same key at the next call", async () => {
    const home = await tempFolder();
    const first = await loadOrCreateRunnerKey(home);

    const second = await loadOrCreateRunnerKey(home);

    expect(second.publicKey).toBe(first.publicKey);
  });

  it("signs with the same private key after a reload", async () => {
    const home = await tempFolder();
    const first = await loadOrCreateRunnerKey(home);

    const second = await loadOrCreateRunnerKey(home);

    expect(second.sign(Buffer.from("hello"))).toBe(first.sign(Buffer.from("hello")));
  });

  it("gives one key to two calls at the same time", async () => {
    const home = await tempFolder();

    const [first, second] = await Promise.all([
      loadOrCreateRunnerKey(home),
      loadOrCreateRunnerKey(home),
    ]);

    expect(second.publicKey).toBe(first.publicKey);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a file that other users can access",
    async () => {
      const home = await tempFolder();
      await loadOrCreateRunnerKey(home);
      await chmod(runnerKeyPath(home), 0o644);

      await expect(loadOrCreateRunnerKey(home)).rejects.toThrow("Other users can access");
    },
  );

  it("reads no key when this machine has none", async () => {
    expect(await readRunnerKey(await tempFolder())).toBeUndefined();
  });

  it("reads the key that a call created", async () => {
    const home = await tempFolder();
    const created = await loadOrCreateRunnerKey(home);

    const read = await readRunnerKey(home);

    expect(read?.publicKey).toBe(created.publicKey);
  });

  it.each([
    ["without a key", '{ "name": "host" }'],
    ["that is not JSON", "{"],
    [
      "whose private key is not of its public key",
      '{ "name": "h", "publicKey": "a", "privateKey": "b" }',
    ],
  ])("refuses a file %s", async (_, content) => {
    const home = await tempFolder();
    await writeFile(runnerKeyPath(home), content, { mode: 0o600 });

    await expect(loadOrCreateRunnerKey(home)).rejects.toThrow("is not a runner key file");
  });
});
