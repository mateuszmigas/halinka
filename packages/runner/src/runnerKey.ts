import { hostname } from "node:os";
import { join } from "node:path";

import { createKeyPair, type KeyPair, type RunnerSigner, signerOf } from "@halinka/protocol/keys";
import { createFileOnce, ensureFolder, readPrivateFile } from "@halinka/utils/fs";

type RunnerFile = KeyPair & { name: string };

export type RunnerKey = RunnerSigner & { name: string };

export const runnerKeyPath = (home: string) => join(home, "runner.json");

const isRunnerFile = (value: unknown): value is RunnerFile => {
  const file = value as Partial<RunnerFile> | null;
  return [file?.name, file?.publicKey, file?.privateKey].every(
    (field) => typeof field === "string" && field.length > 0,
  );
};

const keyOf = (file: RunnerFile): RunnerKey => ({ name: file.name, ...signerOf(file) });

const readKeyFile = async (path: string) => {
  const text = await readPrivateFile(path);
  if (text === undefined) return undefined;
  try {
    const file: unknown = JSON.parse(text);
    if (isRunnerFile(file)) return keyOf(file);
  } catch {}
  throw new Error(`${path} is not a runner key file`);
};

// Another process can create the file at the same time: then its key wins.
const createKeyFile = async (path: string): Promise<RunnerKey> => {
  const file = { name: hostname(), ...createKeyPair() };
  if (await createFileOnce(path, `${JSON.stringify(file, null, 2)}\n`, 0o600)) return keyOf(file);
  const existing = await readKeyFile(path);
  if (!existing) throw new Error(`${path} is not a runner key file`);
  return existing;
};

export const readRunnerKey = (home: string) => readKeyFile(runnerKeyPath(home));

export const loadOrCreateRunnerKey = async (home: string): Promise<RunnerKey> => {
  await ensureFolder(home);
  const path = runnerKeyPath(home);
  return (await readKeyFile(path)) ?? (await createKeyFile(path));
};
