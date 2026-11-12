import { execFile, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { errnoCode } from "@halinka/utils/errors";
import { pathExists, readTextFile } from "@halinka/utils/fs";
import { type ExecCall, Git } from "@halinka/utils/git";

import { checkedCommand, collectOutput, execWithin, toSandboxProcess } from "./process";
import type { ExecOptions, Sandbox, SpawnOptions, WorkspaceOwner } from "./sandbox";

const killGraceMs = 2000;
const pollMs = 100;

const killGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch {}
};

const isGroupEmpty = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return false;
  } catch {
    return true;
  }
};

// True when the group ended.
const waitForEmptyGroup = async (pid: number) => {
  for (let waited = 0; waited < killGraceMs; waited += pollMs) {
    if (isGroupEmpty(pid)) return true;
    await sleep(pollMs);
  }
  return isGroupEmpty(pid);
};

type StartProcessOptions = Omit<ExecOptions, "onOutput"> & {
  workspaceFolder: string;
  groupsFile: string | undefined;
};

const startProcess = (
  command: string[],
  { workspaceFolder, groupsFile, env, signal }: StartProcessOptions,
) => {
  const { file, args } = checkedCommand(command, signal);
  const stopped = Promise.withResolvers<void>();
  // Only a recorded group is detached: a Ctrl-C of the terminal must reach a command of the CLI.
  const isDetached = groupsFile !== undefined;
  const child = spawn(file, args, {
    cwd: workspaceFolder,
    env: { ...process.env, ...env },
    stdio: "pipe",
    detached: isDetached,
  });
  const kill = (pid: number, signal: NodeJS.Signals) =>
    isDetached ? killGroup(pid, signal) : child.kill(signal);
  const isEnded = (pid: number) => !isDetached || isGroupEmpty(pid);
  if (groupsFile && child.pid !== undefined) {
    try {
      appendFileSync(groupsFile, `${child.pid} ${Date.now()}\n`);
    } catch (error) {
      killGroup(child.pid, "SIGKILL");
      throw error;
    }
  }
  // A process outside the group can hold the pipes open.
  const abandonPipes = () => {
    child.stdout.destroy();
    child.stderr.destroy();
  };
  let forceKill: NodeJS.Timeout | undefined;
  const finish = () => {
    stopListening();
    stopped.resolve();
  };
  const stopGroup = () => {
    const { pid } = child;
    if (pid === undefined || forceKill) return;
    kill(pid, "SIGTERM");
    forceKill = setTimeout(() => {
      kill(pid, "SIGKILL");
      abandonPipes();
      if (isDetached) void waitForEmptyGroup(pid).then(finish);
      else finish();
    }, killGraceMs).unref();
  };
  const stop = () => {
    stopGroup();
    if (signal?.aborted && (child.exitCode !== null || child.signalCode !== null)) abandonPipes();
  };
  const stopListening = () => signal?.removeEventListener("abort", stop);
  signal?.addEventListener("abort", stop, { once: true });
  child.on("exit", stop);
  child.on("error", finish);
  child.on("close", () => {
    if (child.pid !== undefined && !isEnded(child.pid)) return;
    clearTimeout(forceKill);
    finish();
  });
  return { child, stopped: stopped.promise };
};

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
};

// A group can outlive its first process, and a first process newer than the record has a reused pid.
const isRecordedGroup = (pid: number, recordedAt: number) =>
  new Promise<boolean>((resolve) => {
    if (!isRunning(pid)) return resolve(true);
    execFile("ps", ["-o", "etime=", "-p", String(pid)], (error, stdout) => {
      const elapsed = stdout.trim();
      if (error || !elapsed) return resolve(false);
      const [days, time] = elapsed.includes("-") ? elapsed.split("-") : ["0", elapsed];
      const seconds = time!.split(":").reduce((total, part) => total * 60 + Number(part), 0);
      resolve(Date.now() - (Number(days) * 86400 + seconds) * 1000 <= recordedAt + 1000);
    });
  });

// After the group ended, the system can give its id to another group.
const terminateGroup = async (pid: number) => {
  killGroup(pid, "SIGTERM");
  if (await waitForEmptyGroup(pid)) return;
  killGroup(pid, "SIGKILL");
  await waitForEmptyGroup(pid);
};

// The recorded groups that have a process; the id of one can be of another group by now.
const readExistingGroups = async (groupsFile: string) => {
  const lines = (await readTextFile(groupsFile))?.split("\n").filter(Boolean) ?? [];
  return lines.flatMap((line) => {
    const [pid = NaN, recordedAt = NaN] = line.split(" ").map(Number);
    // `kill -1` reaches all processes of the user.
    if (pid <= 1 || !Number.isFinite(recordedAt) || isGroupEmpty(pid)) return [];
    return [{ pid, recordedAt }];
  });
};

// Gives the groups that it stopped.
export const stopLeftoverGroups = async (groupsFile: string) => {
  const groups = await readExistingGroups(groupsFile);
  const recorded = await Promise.all(
    groups.map(async ({ pid, recordedAt }) =>
      (await isRecordedGroup(pid, recordedAt)) ? [pid] : [],
    ),
  );
  const live = recorded.flat();
  await Promise.all(live.map(terminateGroup));
  await rm(groupsFile, { force: true });
  return live;
};

export class HostSandbox implements Sandbox {
  constructor(
    readonly workspaceFolder: string,
    private readonly groupsFile?: string,
    // the git locks of the run: the worktree's index and the run branch
    private readonly lockFiles: string[] = [],
  ) {}

  async exec(command: string[], options: ExecOptions = {}) {
    return execWithin(command, options, (within) =>
      collectOutput(this.start(command, within), within),
    );
  }

  async spawn(command: string[], options: SpawnOptions) {
    return toSandboxProcess(this.start(command, options));
  }

  private start(command: string[], options: Omit<ExecOptions, "onOutput">) {
    const { workspaceFolder, groupsFile } = this;
    return startProcess(command, { ...options, workspaceFolder, groupsFile });
  }

  async assignWorkspace(owner: WorkspaceOwner) {
    const { groupsFile, lockFiles } = this;
    if (owner === "agent" || !groupsFile) return;
    const exists = await Promise.all(lockFiles.map(pathExists));
    const locks = lockFiles.filter((_, index) => exists[index]);
    if (locks.length === 0) return;
    // The agent runs as the host user, so a git lock can be of its live process.
    if ((await readExistingGroups(groupsFile)).length > 0) {
      throw new Error(
        `Halinka could not give the workspace back: a process of the run still runs and can hold ${locks.join(", ")}`,
      );
    }
    await Promise.all(locks.map((lock) => rm(lock, { force: true })));
  }
}

export const hostGit = (cwd: string, config?: Record<string, string>, call?: ExecCall) =>
  new Git(new HostSandbox(cwd), config, call);
