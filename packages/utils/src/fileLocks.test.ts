import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { FileLocks } from "./fileLocks";
import { pathExists } from "./fs";
import { tempFolder } from "./testing";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFile: vi.fn(original.execFile) };
});

const signal = new AbortController().signal;

const readHolder = async (folder: string, name: string) =>
  JSON.parse(await readFile(join(folder, `${name}.lock`), "utf8")) as unknown;

const readStartTime = (pid: number | undefined) =>
  execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
  }).trim();

const liveProcess = async () => {
  const child = spawn("sleep", ["30"]);
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  await once(child, "spawn");
  return child;
};

const lockOfLiveProcess = async (folder: string) => {
  const child = await liveProcess();
  const holder = { pid: child.pid, instanceId: "other", startedAtUtc: readStartTime(child.pid) };
  await writeFile(join(folder, "run-1.lock"), JSON.stringify(holder));
  return child;
};

// The start time check of `pid` waits for `answer()`.
const holdStartTimeCheck = async (pid: number | undefined) => {
  const { execFile: realExecFile } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const checked = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<void>();
  type Callback = (error: Error | null, stdout: string, stderr: string) => void;
  vi.mocked(execFile).mockImplementation(((
    file: string,
    args: string[],
    options: object,
    callback: Callback,
  ) => {
    if (!args.includes(String(pid))) return realExecFile(file, args, options, callback);
    checked.resolve();
    void answer.promise.then(() => realExecFile(file, args, options, callback));
  }) as unknown as typeof execFile);
  onTestFinished(() => {
    vi.mocked(execFile).mockReset();
  });
  return { checked: checked.promise, answer: () => answer.resolve() };
};

describe("FileLocks", () => {
  it("waits while another live process holds the lock", async () => {
    const folder = await tempFolder();
    const child = await lockOfLiveProcess(folder);
    const onWait = vi.fn();
    const taking = new FileLocks(folder, "own").take("run-1", signal, onWait);
    await vi.waitFor(() => expect(onWait).toHaveBeenCalledWith(child.pid));

    child.kill("SIGKILL");
    await taking;

    expect(await readHolder(folder, "run-1")).toMatchObject({ instanceId: "own" });
  });

  it("takes another lock at once", async () => {
    const folder = await tempFolder();
    await lockOfLiveProcess(folder);

    await new FileLocks(folder, "own").take("run-2", signal);

    expect(await readHolder(folder, "run-2")).toMatchObject({ instanceId: "own" });
  });

  it("takes the lock again after the release", async () => {
    const folder = await tempFolder();
    const release = await new FileLocks(folder, "own").take("run-1", signal);
    const other = new FileLocks(folder, "other");

    await release();
    await other.take("run-1", signal);

    expect(await readHolder(folder, "run-1")).toMatchObject({ instanceId: "other" });
  });

  it("takes the lock when another task of this process releases it", async () => {
    const folder = await tempFolder();
    const locks = new FileLocks(folder, "own");
    const release = await locks.take("run-1", signal);
    const taking = locks.take("run-1", signal);

    await release();

    await expect(taking).resolves.toBeTypeOf("function");
    expect(await readHolder(folder, "run-1")).toMatchObject({ instanceId: "own" });
  });

  it("gives a lock to one of two takes of this process at the same time", async () => {
    const locks = new FileLocks(await tempFolder(), "own");

    const releases = await Promise.all([locks.tryTake("run-1"), locks.tryTake("run-1")]);

    expect(releases.filter(Boolean)).toHaveLength(1);
  });

  it("gives no lock without a wait while another live process holds it", async () => {
    const folder = await tempFolder();
    await lockOfLiveProcess(folder);

    expect(await new FileLocks(folder, "own").tryTake("run-1")).toBeUndefined();
  });

  it("gives no lock without a wait while this process holds it", async () => {
    const locks = new FileLocks(await tempFolder(), "own");
    await locks.take("run-1", signal);

    expect(await locks.tryTake("run-1")).toBeUndefined();
  });

  const staleLockAt = async (path: string) => {
    const holder = {
      pid: process.ppid,
      instanceId: "old",
      startedAtUtc: "Mon Jan  1 00:00:00 2024",
    };
    await writeFile(path, JSON.stringify(holder));
  };

  it("takes a lock whose pid is now another process", async () => {
    const folder = await tempFolder();
    await staleLockAt(join(folder, "run-1.lock"));

    await new FileLocks(folder, "own").take("run-1", signal);

    expect(await readHolder(folder, "run-1")).toMatchObject({
      instanceId: "own",
      pid: process.pid,
    });
  });

  it("waits while another live process takes over a stale lock", async () => {
    const folder = await tempFolder();
    await staleLockAt(join(folder, "run-1.lock"));
    const taker = await liveProcess();
    const takeover = {
      pid: taker.pid,
      instanceId: "other",
      startedAtUtc: readStartTime(taker.pid),
    };
    await writeFile(join(folder, "run-1.lock.takeover"), JSON.stringify(takeover));
    const onWait = vi.fn();
    const stopping = new AbortController();

    const taking = new FileLocks(folder, "own").take("run-1", stopping.signal, onWait);
    void taking.catch(() => {});

    await vi.waitFor(() => expect(onWait).toHaveBeenCalledWith(taker.pid));
    stopping.abort();
  });

  it("takes a stale lock when the takeover of another taker stopped", async () => {
    const folder = await tempFolder();
    await staleLockAt(join(folder, "run-1.lock"));
    await staleLockAt(join(folder, "run-1.lock.takeover"));

    await new FileLocks(folder, "own").take("run-1", signal);

    expect(await readHolder(folder, "run-1")).toMatchObject({ instanceId: "own" });
  });

  it("removes its takeover file after it took a stale lock", async () => {
    const folder = await tempFolder();
    await staleLockAt(join(folder, "run-1.lock"));

    await new FileLocks(folder, "own").take("run-1", signal);

    expect(await pathExists(join(folder, "run-1.lock.takeover"))).toBe(false);
  });

  it("waits for a live holder whose start time ps cannot read", async () => {
    const folder = await tempFolder();
    const child = await lockOfLiveProcess(folder);
    vi.stubEnv("PATH", "/nonexistent");
    const onWait = vi.fn();
    const stopping = new AbortController();

    const taking = new FileLocks(folder, "own").take("run-1", stopping.signal, onWait);
    void taking.catch(() => {});

    await vi.waitFor(() => expect(onWait).toHaveBeenCalledWith(child.pid));
    stopping.abort();
  });

  it.each([
    { variable: "TZ", value: "Asia/Tokyo" },
    { variable: "LC_ALL", value: "de_DE.UTF-8" },
    { variable: "TZDIR", value: "/usr/share/zoneinfo/right" },
  ])("gives no lock to a process with another $variable", async ({ variable, value }) => {
    const folder = await tempFolder();
    await lockOfLiveProcess(folder);
    vi.stubEnv(variable, value);

    expect(await new FileLocks(folder, "own").tryTake("run-1")).toBeUndefined();
  });

  it("reads its start time again after ps failed", async () => {
    const folder = await tempFolder();
    const locks = new FileLocks(folder, "own");
    vi.stubEnv("PATH", "/nonexistent");
    await locks.take("a", signal);
    vi.unstubAllEnvs();

    await locks.take("b", signal);

    expect(await readHolder(folder, "b")).toMatchObject({
      startedAtUtc: readStartTime(process.pid),
    });
  });

  it("keeps the start time in UTC in its lock", async () => {
    const folder = await tempFolder();
    vi.stubEnv("TZ", "Asia/Tokyo");

    await new FileLocks(folder, "own").take("run-1", signal);

    expect(await readHolder(folder, "run-1")).toMatchObject({
      startedAtUtc: readStartTime(process.pid),
    });
  });

  it.each([
    { name: "a lock of an older version", time: { startedAt: "Mon Jan  1 00:00:00 2024" } },
    { name: "an empty start time", time: { startedAtUtc: "" } },
  ])("gives no lock while a live holder has $name", async ({ time }) => {
    const folder = await tempFolder();
    const child = await liveProcess();
    const holder = { pid: child.pid, instanceId: "other", ...time };
    await writeFile(join(folder, "run-1.lock"), JSON.stringify(holder));

    expect(await new FileLocks(folder, "own").tryTake("run-1")).toBeUndefined();
  });

  it("takes a lock of an older version when its pid is gone", async () => {
    const folder = await tempFolder();
    const child = await liveProcess();
    const pid = child.pid;
    child.kill("SIGKILL");
    await once(child, "exit");
    const holder = { pid, instanceId: "other", startedAt: "Mon Jan  1 00:00:00 2024" };
    await writeFile(join(folder, "run-1.lock"), JSON.stringify(holder));

    await new FileLocks(folder, "own").take("run-1", signal);

    expect(await readHolder(folder, "run-1")).toMatchObject({ instanceId: "own" });
  });

  it("stops the wait when the signal aborts", async () => {
    const folder = await tempFolder();
    await lockOfLiveProcess(folder);
    const stopping = new AbortController();
    const onWait = vi.fn();
    const taking = new FileLocks(folder, "own").take("run-1", stopping.signal, onWait);
    await vi.waitFor(() => expect(onWait).toHaveBeenCalled());

    stopping.abort();

    await expect(taking).rejects.toMatchObject({ name: "AbortError" });
  });

  it("takes a lock that this runner process left", async () => {
    const folder = await tempFolder();
    const holder = {
      pid: process.pid,
      instanceId: "own",
      startedAtUtc: readStartTime(process.pid),
    };
    await writeFile(join(folder, "run-1.lock"), JSON.stringify(holder));

    await new FileLocks(folder, "own").take("run-1", signal);

    expect(await readHolder(folder, "run-1")).toMatchObject({
      instanceId: "own",
      pid: process.pid,
    });
  });

  it("takes a lock whose file is not a lock", async () => {
    const folder = await tempFolder();
    await writeFile(join(folder, "run-1.lock"), "{");

    await new FileLocks(folder, "own").take("run-1", signal);

    expect(await readHolder(folder, "run-1")).toMatchObject({
      instanceId: "own",
      pid: process.pid,
    });
  });

  it("keeps the lock of another process at a release", async () => {
    const folder = await tempFolder();
    const release = await new FileLocks(folder, "own").take("run-1", signal);
    const child = await lockOfLiveProcess(folder);

    await release();

    expect(await readFile(join(folder, "run-1.lock"), "utf8")).toContain(String(child.pid));
  });

  it("keeps the lock that another process made after it read a stale lock", async () => {
    const folder = await tempFolder();
    const reused = await liveProcess();
    const stale = { pid: reused.pid, instanceId: "old", startedAtUtc: "Mon Jan  1 00:00:00 2024" };
    await writeFile(join(folder, "run-1.lock"), JSON.stringify(stale));
    const staleCheck = await holdStartTimeCheck(reused.pid);
    const stopping = new AbortController();
    const onWait = vi.fn();
    const taking = new FileLocks(folder, "own").take("run-1", stopping.signal, onWait);
    void taking.catch(() => {});
    await staleCheck.checked;
    const newer = await lockOfLiveProcess(folder);

    staleCheck.answer();

    await vi.waitFor(() => expect(onWait).toHaveBeenCalledWith(newer.pid));
    stopping.abort();
  });
});
