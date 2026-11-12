import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { errnoCode } from "./errors";
import { createFileOnce, ensureFolder, readTextFile } from "./fs";

// A lock of an older version does not have `startedAtUtc`.
type Holder = { pid: number; instanceId: string; startedAtUtc?: string };

const waitMs = 500;

// The output of `ps` changes with the environment of the caller.
const readStartTime = (pid: number) =>
  new Promise<string>((resolve) => {
    execFile(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      { env: { PATH: process.env.PATH, TZ: "UTC", LC_ALL: "C" } },
      (error, stdout) => resolve(error ? "" : stdout.trim()),
    );
  });

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
};

const parseHolder = (text: string): Holder | undefined => {
  try {
    return JSON.parse(text) as Holder;
  } catch {
    return undefined;
  }
};

const readHolder = async (path: string) => parseHolder((await readTextFile(path)) ?? "");

// Another taker can replace the stale lock after the read: move the file, and put back another lock.
const deleteStale = async (path: string, staleText: string) => {
  const moved = `${path}.${randomUUID()}`;
  try {
    await rename(path, moved);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    throw error;
  }
  if ((await readTextFile(moved)) !== staleText) {
    await link(moved, path).catch((error: unknown) => {
      if (errnoCode(error) !== "EEXIST") throw error;
    });
  }
  await rm(moved, { force: true });
};

const isReusedPid = async ({ pid, startedAtUtc }: Holder) => {
  if (!startedAtUtc) return false;
  const current = await readStartTime(pid);
  // `ps` failed: no proof that the pid is another process.
  return current !== "" && current !== startedAtUtc;
};

// A lock of this instance that it does not hold is left from an earlier take.
const isStale = async (holder: Holder, instanceId: string) =>
  holder.instanceId === instanceId || !isRunning(holder.pid) || (await isReusedPid(holder));

export type Release = () => Promise<void>;

// Locks between processes, one file `<name>.lock` each in `folder`.
export class FileLocks {
  private readonly held = new Set<string>();
  private ownStart = "";

  constructor(
    private readonly folder: string,
    private readonly instanceId: string,
  ) {}

  async take(name: string, signal?: AbortSignal, onWait: (holderPid: number) => void = () => {}) {
    for (let hasWaited = false; ;) {
      signal?.throwIfAborted();
      const attempt = await this.attempt(name);
      if (typeof attempt === "function") return attempt;
      if (!hasWaited && attempt) onWait(attempt.pid);
      hasWaited = true;
      await sleep(waitMs, undefined, { signal });
    }
  }

  // `undefined` also while another task of this process holds the lock.
  async tryTake(name: string) {
    const attempt = await this.attempt(name);
    return typeof attempt === "function" ? attempt : undefined;
  }

  // Mark the name held before the first await, so two tasks never both take it.
  private async attempt(name: string): Promise<Release | Holder | undefined> {
    if (this.held.has(name)) return undefined;
    this.held.add(name);
    let isTaken = false;
    try {
      const holder = await this.lockFile(name);
      if (holder) return holder;
      isTaken = true;
      return () => this.release(name);
    } finally {
      if (!isTaken) this.held.delete(name);
    }
  }

  // The live holder, or `undefined` when this process took the lock.
  private async lockFile(name: string) {
    await ensureFolder(this.folder);
    const path = this.pathOf(name);
    this.ownStart ||= await readStartTime(process.pid);
    const own = JSON.stringify({
      pid: process.pid,
      instanceId: this.instanceId,
      startedAtUtc: this.ownStart,
    } satisfies Holder);
    for (;;) {
      if (await createFileOnce(path, own)) return undefined;
      const text = await readTextFile(path);
      if (text === undefined) continue;
      const holder = await this.findLiveHolder(text);
      if (holder) return holder;
      const taker = await this.deleteInTakeover(path, text, own);
      if (taker) return taker;
    }
  }

  // One takeover at a time, so no taker removes a lock that another taker made after its read.
  private async deleteInTakeover(path: string, staleText: string, own: string) {
    const takeoverPath = `${path}.takeover`;
    for (;;) {
      if (await createFileOnce(takeoverPath, own)) break;
      const text = await readTextFile(takeoverPath);
      if (text === undefined) continue;
      const taker = await this.findLiveHolder(text);
      if (taker) return taker;
      // Only a taker that stopped during its takeover leaves this file.
      await deleteStale(takeoverPath, text);
    }
    try {
      if ((await readTextFile(path)) === staleText) await rm(path, { force: true });
    } finally {
      await rm(takeoverPath, { force: true });
    }
    return undefined;
  }

  private async findLiveHolder(text: string) {
    const holder = parseHolder(text);
    return holder && !(await isStale(holder, this.instanceId)) ? holder : undefined;
  }

  private async release(name: string) {
    const path = this.pathOf(name);
    try {
      if ((await readHolder(path))?.instanceId === this.instanceId) await rm(path, { force: true });
    } finally {
      this.held.delete(name);
    }
  }

  private pathOf(name: string) {
    return join(this.folder, `${name}.lock`);
  }
}
