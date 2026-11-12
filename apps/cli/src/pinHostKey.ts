import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { isSshHostKey } from "@halinka/protocol";
import { FileLocks } from "@halinka/utils/fileLocks";
import { ensureFolder, readTextFile, replaceFile } from "@halinka/utils/fs";
import { halinkaHome } from "@halinka/utils/halinkaHome";
import { z } from "zod";

// The key of each runner, by server and runner id, from the first use.
const hostKeysFileSchema = z.record(z.string(), z.record(z.string(), z.string()));

const hostKeysPath = () => join(halinkaHome(), "ssh_host_keys.json");

const readHostKeys = async () => {
  const text = await readTextFile(hostKeysPath());
  return text === undefined ? {} : hostKeysFileSchema.parse(JSON.parse(text));
};

type SavedKeyOptions = { server: string; runnerId: number };

const checkedSavedKey = (saved: string, offered: string, { server, runnerId }: SavedKeyOptions) => {
  if (!isSshHostKey(saved)) throw new Error(`${hostKeysPath()} holds a key that is not valid`);
  if (saved !== offered) {
    console.error(
      `The SSH key of runner ${runnerId} changed on ${server}. If its owner made a new key, remove the old key from ${hostKeysPath()}.`,
    );
  }
  return saved;
};

// The server gives the key, so only a key that this computer saved earlier can show a change.
export const pinHostKey = async (server: string, runnerId: number, offered: string) => {
  if (!isSshHostKey(offered)) throw new Error(`${server} gave an SSH key that is not valid`);
  await ensureFolder(halinkaHome());
  // VS Code starts several `ssh`: a write of one must keep the key that another saved.
  const release = await new FileLocks(halinkaHome(), randomUUID()).take("ssh-host-keys");
  try {
    const keys = await readHostKeys();
    const saved = keys[server]?.[runnerId];
    if (saved !== undefined) return checkedSavedKey(saved, offered, { server, runnerId });
    await replaceFile(
      hostKeysPath(),
      JSON.stringify({ ...keys, [server]: { ...keys[server], [runnerId]: offered } }),
      0o600,
    );
    return offered;
  } finally {
    await release();
  }
};
