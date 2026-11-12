import { join } from "node:path";

import { createFileOnce, ensureFolder, readPrivateFile } from "@halinka/utils/fs";
import ssh2 from "ssh2";

const { utils } = ssh2;

// ssh2 removes a zero byte at the start of a public key, and then cannot read the key.
const newKey = () => {
  for (;;) {
    const key = utils.generateKeyPairSync("ed25519").private;
    if (!(utils.parseKey(key) instanceof Error)) return key;
  }
};

const publicKeyOf = (path: string, privateKey: string) => {
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) {
    throw new Error(`${path} is not an SSH key. Remove the file, and the runner makes a new one.`);
  }
  const key = Array.isArray(parsed) ? parsed[0]! : parsed;
  return `${key.type} ${key.getPublicSSH().toString("base64")}`;
};

// The person's computer keeps this key: a new one makes `ssh` refuse the runner.
export const loadOrCreateSshHostKey = async (home: string) => {
  await ensureFolder(home);
  const path = join(home, "ssh_host_key");
  const privateKey = await readPrivateFile(path);
  if (privateKey !== undefined) return { privateKey, publicKey: publicKeyOf(path, privateKey) };
  const created = newKey();
  await createFileOnce(path, created, 0o600);
  const saved = (await readPrivateFile(path)) ?? created;
  return { privateKey: saved, publicKey: publicKeyOf(path, saved) };
};
