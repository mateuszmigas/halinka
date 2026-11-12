import { randomBytes } from "node:crypto";
import { chmod, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it, vi } from "vitest";

import { loadMasterKey } from "./loadMasterKey";

const setUp = async () => {
  const home = await tempFolder();
  vi.stubEnv("HALINKA_HOME", home);
  vi.stubEnv("HALINKA_MASTER_KEY", undefined);
  return { keyPath: join(home, "master_key") };
};

describe("loadMasterKey", () => {
  it("uses the key of the environment", async () => {
    await setUp();
    const key = randomBytes(32);
    vi.stubEnv("HALINKA_MASTER_KEY", key.toString("base64"));

    expect(await loadMasterKey({ hasLogin: true })).toEqual(key);
  });

  it("refuses an empty key instead of a key file", async () => {
    await setUp();
    vi.stubEnv("HALINKA_MASTER_KEY", "");

    await expect(loadMasterKey({ hasLogin: false })).rejects.toThrow("32 bytes");
  });

  it("refuses a server with a login without a key", async () => {
    await setUp();

    await expect(loadMasterKey({ hasLogin: true })).rejects.toThrow("needs HALINKA_MASTER_KEY");
  });

  it("creates a private file on this machine", async () => {
    const { keyPath } = await setUp();
    await loadMasterKey({ hasLogin: false });

    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
  });

  it("reads the file the next time", async () => {
    await setUp();
    const created = await loadMasterKey({ hasLogin: false });

    expect(await loadMasterKey({ hasLogin: false })).toEqual(created);
  });

  it("gives two starts at one time the same key", async () => {
    await setUp();
    const [first, second] = await Promise.all([
      loadMasterKey({ hasLogin: false }),
      loadMasterKey({ hasLogin: false }),
    ]);

    expect(first).toEqual(second);
  });

  it("refuses a file that other users can read", async () => {
    const { keyPath } = await setUp();
    await loadMasterKey({ hasLogin: false });
    await chmod(keyPath, 0o644);

    await expect(loadMasterKey({ hasLogin: false })).rejects.toThrow("Other users can access");
  });

  it("refuses a file without a key", async () => {
    const { keyPath } = await setUp();
    await writeFile(keyPath, "short\n", { mode: 0o600 });

    await expect(loadMasterKey({ hasLogin: false })).rejects.toThrow("is not a master key");
  });
});
