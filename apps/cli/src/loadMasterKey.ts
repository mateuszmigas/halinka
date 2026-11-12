import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { parseMasterKey } from "@halinka/server";
import { createFileOnce, readPrivateFile } from "@halinka/utils/fs";
import { halinkaHome } from "@halinka/utils/halinkaHome";

type LoadMasterKeyOptions = { hasLogin: boolean };

const readKeyFile = async (path: string) => {
  const text = await readPrivateFile(path);
  if (text === undefined) return undefined;
  try {
    return parseMasterKey(text);
  } catch {
    throw new Error(`${path} is not a master key`);
  }
};

// A server with a login must not keep its key next to the data.
export const loadMasterKey = async ({ hasLogin }: LoadMasterKeyOptions) => {
  const value = process.env.HALINKA_MASTER_KEY;
  if (value !== undefined) return parseMasterKey(value);
  if (hasLogin) {
    throw new Error("A server with a login needs HALINKA_MASTER_KEY: openssl rand -base64 32");
  }
  const path = join(halinkaHome(), "master_key");
  const saved = await readKeyFile(path);
  if (saved) return saved;
  const created = randomBytes(32);
  if (await createFileOnce(path, `${created.toString("base64")}\n`, 0o600)) return created;
  const other = await readKeyFile(path);
  if (!other) throw new Error(`${path} is not a master key`);
  return other;
};
