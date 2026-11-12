import { chmod, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isSshHostKey } from "@halinka/protocol";
import { tempFolder } from "@halinka/utils/testing";
import ssh2 from "ssh2";
import { describe, expect, it, vi } from "vitest";

import { loadOrCreateSshHostKey } from "./loadOrCreateSshHostKey";

describe("loadOrCreateSshHostKey", () => {
  it("gives a public key in the format of the protocol", async () => {
    const { publicKey } = await loadOrCreateSshHostKey(await tempFolder());

    expect(isSshHostKey(publicKey)).toBe(true);
  });

  it("makes another key when ssh2 cannot read the key that it made", async () => {
    const { generateKeyPairSync } = ssh2.utils;
    const good = generateKeyPairSync("ed25519");
    vi.spyOn(ssh2.utils, "generateKeyPairSync")
      .mockReturnValueOnce({ ...good, private: "not a key" })
      .mockReturnValueOnce(good);

    const { privateKey } = await loadOrCreateSshHostKey(await tempFolder());

    expect(privateKey).toBe(good.private);
  });

  it("gives the same key at the next start", async () => {
    const home = await tempFolder();

    const first = await loadOrCreateSshHostKey(home);

    expect(await loadOrCreateSshHostKey(home)).toEqual(first);
  });

  it("keeps the file from other users", async () => {
    const home = await tempFolder();

    await loadOrCreateSshHostKey(home);

    expect((await stat(join(home, "ssh_host_key"))).mode & 0o777).toBe(0o600);
  });

  it("names the file when it holds no key", async () => {
    const home = await tempFolder();
    await writeFile(join(home, "ssh_host_key"), "no key", { mode: 0o600 });

    await expect(loadOrCreateSshHostKey(home)).rejects.toThrow(
      `${join(home, "ssh_host_key")} is not an SSH key`,
    );
  });

  it("refuses a file that other users can read", async () => {
    const home = await tempFolder();
    await loadOrCreateSshHostKey(home);
    await chmod(join(home, "ssh_host_key"), 0o644);

    await expect(loadOrCreateSshHostKey(home)).rejects.toThrow("Other users can access");
  });
});
