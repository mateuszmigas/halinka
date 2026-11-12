import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { FileLocks } from "@halinka/utils/fileLocks";
import { ensureFolder, readTextFile, replaceFile } from "@halinka/utils/fs";
import { halinkaHome } from "@halinka/utils/halinkaHome";
import { z } from "zod";

const loginsFileSchema = z.object({
  current: z.string().optional(),
  tokens: z.record(z.string(), z.object({ token: z.string(), login: z.string() })),
});

type Logins = z.infer<typeof loginsFileSchema>;

const loginsPath = () => join(halinkaHome(), "logins.json");

export const readLogins = async (): Promise<Logins> => {
  const text = await readTextFile(loginsPath());
  if (text === undefined) return { tokens: {} };
  try {
    return loginsFileSchema.parse(JSON.parse(text));
  } catch {
    throw new Error(`${loginsPath()} is not valid. Remove the file, then log in again.`);
  }
};

// Two commands can change the file at one time: each change starts from the latest file.
export const updateLogins = async (change: (logins: Logins) => Logins) => {
  await ensureFolder(halinkaHome());
  const release = await new FileLocks(halinkaHome(), randomUUID()).take("logins");
  try {
    await replaceFile(loginsPath(), JSON.stringify(change(await readLogins())), 0o600);
  } finally {
    await release();
  }
};

// A token goes only to the URL of its login: a repo can select another server.
export const readToken = async (server: string) =>
  (await readLogins().catch(() => undefined))?.tokens[server]?.token;

export const logInHint = (server: string) => `Log in first: halinka login --server ${server}`;
