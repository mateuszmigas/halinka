import { spawn, spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";

import { pathExists } from "@halinka/utils/fs";
import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { HostSandbox, hostGit, stopLeftoverGroups } from "./host";
import { outputLimitCode } from "./sandbox";
import { firstLine } from "./testing";

const startOutsideGroup = [
  'const child = require("node:child_process").spawn("sleep", ["30"], {',
  '  detached: true, stdio: ["ignore", "inherit", "inherit"] });',
  "child.unref();",
  "console.log(child.pid);",
].join(" ");

// A zombie has ended: only the system has not removed it yet.
const isRunning = (pid: number) => {
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout;
  return state.trim() !== "" && !state.startsWith("Z");
};

const setUp = async () => {
  const folder = await tempFolder();
  const groupsFile = `${folder}.groups`;
  const lockFiles = [join(folder, "index.lock"), join(folder, "run.lock")];
  const started: number[] = [];
  const controller = new AbortController();
  onTestFinished(async () => {
    controller.abort();
    for (const pid of started) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await rm(`${folder}.test-groups`, { force: true });
    await rm(groupsFile, { force: true });
  });
  const sandbox = new HostSandbox(folder, `${folder}.test-groups`);

  const startUnrecordedGroup = async (script: string) => {
    const child = spawn("sh", ["-c", script], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const pids = (await firstLine(output)).split(" ").map(Number);
    started.push(...pids);
    return pids;
  };

  const writeLockFiles = () => Promise.all(lockFiles.map((lock) => writeFile(lock, "")));

  const startGroup = async (groupSandbox: HostSandbox) => {
    const groupControl = new AbortController();
    const child = await groupSandbox.spawn(["sh", "-c", "echo $$; sleep 30"], {
      signal: groupControl.signal,
    });
    started.push(Number(await firstLine(child.stdout)));
    onTestFinished(async () => {
      groupControl.abort();
      await child.stopped;
    });
  };

  const stagedRepo = async (file: string, content: string) => {
    const git = hostGit(folder);
    await git.run("init", "--quiet");
    await writeFile(join(folder, file), content);
    await git.run("add", ".");
    return git;
  };

  return {
    folder,
    sandbox,
    started,
    controller,
    groupsFile,
    lockFiles,
    startUnrecordedGroup,
    writeLockFiles,
    startGroup,
    stagedRepo,
  };
};

describe("HostSandbox", () => {
  it("runs the command in the workspace folder", async () => {
    const { folder, sandbox } = await setUp();
    const result = await sandbox.exec(["pwd"]);

    expect(result).toEqual({ exitCode: 0, stdout: `${folder}\n`, stderr: "" });
  });

  it("returns the exit code and both streams", async () => {
    const { sandbox } = await setUp();
    const result = await sandbox.exec(["sh", "-c", "echo out; echo err >&2; exit 3"]);

    expect(result).toEqual({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
  });

  it("adds the env to the process environment", async () => {
    const { sandbox } = await setUp();
    const result = await sandbox.exec(["sh", "-c", 'echo "$NAME:$PATH"'], {
      env: { NAME: "halinka" },
    });

    expect(result.stdout).toBe(`halinka:${process.env.PATH}\n`);
  });

  it("gives the command an empty stdin", async () => {
    const { sandbox } = await setUp();
    const result = await sandbox.exec(["cat"]);

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("keeps no stdout and only the end of stderr without isOutputKept", async () => {
    const { sandbox } = await setUp();
    const script = "echo out; head -c 5000 /dev/zero | tr '\\0' a >&2; echo end >&2";

    const result = await sandbox.exec(["sh", "-c", script], { isOutputKept: false });

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`${"a".repeat(4092)}end\n`);
  });

  it("reports each output chunk without isOutputKept", async () => {
    const { sandbox } = await setUp();
    const chunks: string[] = [];

    await sandbox.exec(["echo", "out"], {
      isOutputKept: false,
      onOutput: (chunk) => chunks.push(chunk),
    });

    expect(chunks.join("")).toBe("out\n");
  });

  it("reports each output chunk with its stream", async () => {
    const { sandbox } = await setUp();
    const chunks: [string, string][] = [];

    await sandbox.exec(["sh", "-c", "echo out; echo err >&2"], {
      onOutput: (chunk, stream) => chunks.push([stream, chunk]),
    });

    expect(chunks).toEqual(
      expect.arrayContaining([
        ["stdout", "out\n"],
        ["stderr", "err\n"],
      ]),
    );
  });

  it("stops the process when the signal aborts", async () => {
    const { sandbox } = await setUp();
    const controller = new AbortController();
    const exec = sandbox.exec(["sleep", "10"], { signal: controller.signal });

    controller.abort();

    await expect(exec).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
  });

  it("rejects at the time limit with an error that is not an AbortError", async () => {
    const { sandbox } = await setUp();
    const exec = sandbox.exec(["sleep", "10"], { timeoutMs: 100 });

    await expect(exec).rejects.toThrow(
      expect.objectContaining({
        name: "Error",
        message: "The sandbox did not end `sleep` in 0.1 s",
      }),
    );
  });

  it("rejects a command whose output is longer than the limit", async () => {
    const { sandbox } = await setUp();
    const exec = sandbox.exec(["yes"], { maxOutputChars: 1000 });

    await expect(exec).rejects.toThrow(
      expect.objectContaining({
        name: "Error",
        code: outputLimitCode,
        message: "The output of `yes` is longer than 1000 characters",
      }),
    );
  });

  it("returns the output when it is as long as the limit", async () => {
    const { sandbox } = await setUp();
    const result = await sandbox.exec(["printf", "12345"], { maxOutputChars: 5 });

    expect(result.stdout).toBe("12345");
  });

  it("counts stdout and stderr together for the output limit", async () => {
    const { sandbox } = await setUp();
    const exec = sandbox.exec(["sh", "-c", "printf 123; printf 456 >&2"], { maxOutputChars: 5 });

    await expect(exec).rejects.toThrow("The output of `sh` is longer than 5 characters");
  });

  it("reports each output chunk when the call has an output limit", async () => {
    const { sandbox } = await setUp();
    const chunks: [string, string][] = [];

    await sandbox.exec(["sh", "-c", "echo out; echo err >&2"], {
      maxOutputChars: 1000,
      onOutput: (chunk, stream) => chunks.push([stream, chunk]),
    });

    expect(chunks).toEqual(
      expect.arrayContaining([
        ["stdout", "out\n"],
        ["stderr", "err\n"],
      ]),
    );
  });

  it("rejects with an AbortError when the signal aborts a call with an output limit", async () => {
    const { sandbox } = await setUp();
    const controller = new AbortController();
    const exec = sandbox.exec(["sleep", "10"], {
      maxOutputChars: 1000,
      signal: controller.signal,
    });

    controller.abort();

    await expect(exec).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
  });

  it("rejects with an AbortError when the signal aborts before the time limit", async () => {
    const { sandbox } = await setUp();
    const controller = new AbortController();
    const exec = sandbox.exec(["sleep", "10"], { timeoutMs: 10_000, signal: controller.signal });

    controller.abort();

    await expect(exec).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
  });

  it("also stops the processes that the command starts", async () => {
    const { sandbox, started } = await setUp();
    const controller = new AbortController();
    const childPid = Promise.withResolvers<number>();
    const exec = sandbox.exec(["sh", "-c", "sleep 10 & echo $!; wait"], {
      signal: controller.signal,
      onOutput: (chunk) => childPid.resolve(Number(chunk.trim())),
    });
    const pid = await childPid.promise;
    started.push(pid);

    controller.abort();

    await expect(exec).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });

  it("stops the processes that the command leaves when it exits", async () => {
    const { sandbox, started } = await setUp();
    const result = await sandbox.exec(["sh", "-c", "sleep 10 >/dev/null 2>&1 & echo $!"]);
    const pid = Number(result.stdout.trim());
    started.push(pid);

    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });

  it("returns when the command exits and a process that it leaves keeps the output open", async () => {
    const { sandbox, started } = await setUp();
    const result = await sandbox.exec(["sh", "-c", "sleep 10 & echo $!"]);
    started.push(Number(result.stdout.trim()));

    expect(result.exitCode).toBe(0);
  }, 3000);

  it("returns after it killed a process that the command leaves and that ignores SIGTERM", async () => {
    const { sandbox, started } = await setUp();
    const result = await sandbox.exec([
      "sh",
      "-c",
      'trap "" TERM; (while :; do sleep 0.1; done) >/dev/null 2>&1 & echo $!',
    ]);
    const pid = Number(result.stdout.trim());
    started.push(pid);

    expect(isRunning(pid)).toBe(false);
  }, 5000);

  it("returns when the command exits and a process outside the group keeps the output open", async () => {
    const { sandbox, started } = await setUp();
    const result = await sandbox.exec(["sh", "-c", `"$NODE" -e '${startOutsideGroup}'; exit 4`], {
      env: { NODE: process.execPath },
    });
    started.push(Number(result.stdout.trim()));

    expect(result.exitCode).toBe(4);
  });

  it("rejects after an abort when a process outside the group keeps the output open", async () => {
    const { sandbox, started } = await setUp();
    const controller = new AbortController();
    const outside = Promise.withResolvers<number>();
    const exec = sandbox.exec(["sh", "-c", `"$NODE" -e '${startOutsideGroup}'; sleep 30`], {
      env: { NODE: process.execPath },
      signal: controller.signal,
      onOutput: (chunk) => outside.resolve(Number(chunk.trim())),
    });
    started.push(await outside.promise);

    controller.abort();

    await expect(exec).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
  });

  it("kills the group when the command ignores SIGTERM", async () => {
    const { sandbox } = await setUp();
    const controller = new AbortController();
    const ready = Promise.withResolvers<void>();
    const exec = sandbox.exec(
      ["sh", "-c", 'trap "" TERM; echo ready; while :; do sleep 0.1; done'],
      {
        signal: controller.signal,
        onOutput: () => ready.resolve(),
      },
    );
    await ready.promise;

    controller.abort();

    await expect(exec).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
  }, 5000);

  it("rejects at once when the signal is already aborted", async () => {
    const { sandbox } = await setUp();
    await expect(sandbox.exec(["pwd"], { signal: AbortSignal.abort() })).rejects.toThrow(
      expect.objectContaining({ name: "AbortError" }),
    );
  });

  it("starts the command in the process group of the caller without a groups file", async () => {
    const { folder } = await setUp();
    const processGroupOf = (pid: number | string) =>
      spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();

    const { stdout } = await new HostSandbox(folder).exec(["sh", "-c", "ps -o pgid= -p $$"]);

    expect(stdout.trim()).toBe(processGroupOf(process.pid));
  });

  it("rejects an empty command", async () => {
    const { sandbox } = await setUp();
    await expect(sandbox.exec([])).rejects.toThrow("Command is empty");
  });

  it("rejects when the command does not exist", async () => {
    const { sandbox } = await setUp();
    await expect(sandbox.exec(["halinka-missing-command"])).rejects.toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });
  it("passes stdin to the process", async () => {
    const { sandbox, controller } = await setUp();
    const child = await sandbox.spawn(["cat"], { signal: controller.signal });
    const writer = child.stdin.getWriter();

    await writer.write(new TextEncoder().encode("hello\n"));
    await writer.close();

    expect(await text(child.stdout)).toBe("hello\n");
  });

  it("gives the exit code when the process exits", async () => {
    const { sandbox, controller } = await setUp();
    const child = await sandbox.spawn(["sh", "-c", "exit 3"], { signal: controller.signal });

    expect(await child.exited).toBe(3);
  });

  it("keeps stdout and stderr apart", async () => {
    const { sandbox, controller } = await setUp();
    const child = await sandbox.spawn(["sh", "-c", "echo out; echo err >&2"], {
      signal: controller.signal,
    });

    expect(await Promise.all([text(child.stdout), text(child.stderr)])).toEqual(["out\n", "err\n"]);
  });

  it("stops the process and the processes it starts when the signal aborts", async () => {
    const { sandbox, started, controller } = await setUp();
    const child = await sandbox.spawn(["sh", "-c", "sleep 10 & echo $!; wait"], {
      signal: controller.signal,
    });
    const pid = Number(await firstLine(child.stdout));
    started.push(pid);

    controller.abort();

    await child.exited;
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });

  it("ends `stopped` after the processes that the command leaves end", async () => {
    const { sandbox, started, controller } = await setUp();
    const child = await sandbox.spawn(
      ["sh", "-c", 'trap "" TERM; (while :; do sleep 0.1; done) >/dev/null 2>&1 & echo $!'],
      { signal: controller.signal },
    );
    const pid = Number(await firstLine(child.stdout));
    started.push(pid);

    await child.stopped;

    expect(isRunning(pid)).toBe(false);
  }, 5000);

  it("ends stdout when the process exits and a process that it leaves keeps stdout open", async () => {
    const { sandbox, started, controller } = await setUp();
    const child = await sandbox.spawn(["sh", "-c", "sleep 10 & echo $!"], {
      signal: controller.signal,
    });
    const stdout = await text(child.stdout);
    started.push(Number(stdout.trim()));

    expect(stdout).toMatch(/^\d+\n$/);
  }, 3000);

  it("rejects a read of stderr when the process exits and a process outside the group keeps it open", async () => {
    const { sandbox, started, controller } = await setUp();
    const child = await sandbox.spawn(["sh", "-c", `"$NODE" -e '${startOutsideGroup}'`], {
      env: { NODE: process.execPath },
      signal: controller.signal,
    });
    started.push(Number(await firstLine(child.stdout)));

    await expect(text(child.stderr)).rejects.toThrow(
      expect.objectContaining({ name: "AbortError" }),
    );
  });

  it("rejects a read of stdout after an abort when a process outside the group keeps it open", async () => {
    const { sandbox, started, controller } = await setUp();
    const child = await sandbox.spawn(["sh", "-c", `"$NODE" -e '${startOutsideGroup}'; sleep 30`], {
      env: { NODE: process.execPath },
      signal: controller.signal,
    });
    started.push(Number(await firstLine(child.stdout)));

    controller.abort();

    await expect(text(child.stdout)).rejects.toThrow(
      expect.objectContaining({ name: "AbortError" }),
    );
  });

  it("gives exit code 1 when the signal stops the process", async () => {
    const { sandbox, controller } = await setUp();
    const child = await sandbox.spawn(["sleep", "10"], { signal: controller.signal });

    controller.abort();

    expect(await child.exited).toBe(1);
  });

  it("errors stdin when the process exits before a write", async () => {
    const { sandbox, controller } = await setUp();
    const child = await sandbox.spawn(["true"], { signal: controller.signal });
    await child.exited;
    const writer = child.stdin.getWriter();

    void writer.write(new TextEncoder().encode("late\n")).catch(() => {});

    await expect(writer.closed).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
  });

  it("rejects a spawn at once when the signal is already aborted", async () => {
    const { sandbox } = await setUp();
    await expect(sandbox.spawn(["pwd"], { signal: AbortSignal.abort() })).rejects.toThrow(
      expect.objectContaining({ name: "AbortError" }),
    );
  });

  it("rejects a spawn when the command does not exist", async () => {
    const { sandbox, controller } = await setUp();
    await expect(
      sandbox.spawn(["halinka-missing-command"], { signal: controller.signal }),
    ).rejects.toThrow(expect.objectContaining({ code: "ENOENT" }));
  });

  it("records each group that it starts", async () => {
    const { folder, groupsFile } = await setUp();
    const recording = new HostSandbox(folder, groupsFile);

    const result = await recording.exec(["sh", "-c", "echo $$"]);

    expect(await readFile(groupsFile, "utf8")).toMatch(
      new RegExp(`^${result.stdout.trim()} \\d+\n$`),
    );
  });

  it("rejects the command when it cannot record its group", async () => {
    const { folder } = await setUp();
    const recording = new HostSandbox(folder, join(folder, "missing", "groups"));

    await expect(recording.exec(["true"])).rejects.toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("stops a group that continues after its sandbox and ignores SIGTERM", async () => {
    const { folder, started, groupsFile } = await setUp();
    const recording = new HostSandbox(folder, groupsFile);
    const child = await recording.spawn(
      ["sh", "-c", 'trap "" TERM; echo $$; while :; do sleep 0.1; done'],
      { signal: new AbortController().signal },
    );
    const group = Number(await firstLine(child.stdout));
    started.push(group);

    expect(await stopLeftoverGroups(groupsFile)).toEqual([group]);
    expect(() => process.kill(-group, 0)).toThrow();
  }, 10_000);

  it("deletes the groups file", async () => {
    const { folder, groupsFile } = await setUp();
    await new HostSandbox(folder, groupsFile).exec(["true"]);

    await stopLeftoverGroups(groupsFile);

    await expect(readFile(groupsFile)).rejects.toThrow();
  });

  it("stops a group after its first process ended", async () => {
    const { groupsFile, startUnrecordedGroup } = await setUp();
    const [group, pid] = await startUnrecordedGroup("sleep 30 >/dev/null & echo $$ $!");
    await vi.waitFor(() => expect(isRunning(group!)).toBe(false));
    await writeFile(groupsFile, `${group} ${Date.now()}\n`);

    await stopLeftoverGroups(groupsFile);

    expect(isRunning(pid!)).toBe(false);
  });

  it("keeps a group whose first process started after the record", async () => {
    const { groupsFile, startUnrecordedGroup } = await setUp();
    const [group] = await startUnrecordedGroup("echo $$; exec sleep 30");
    await writeFile(groupsFile, `${group} ${Date.now() - 60_000}\n`);

    await stopLeftoverGroups(groupsFile);

    expect(isRunning(group!)).toBe(true);
  });

  it("keeps a group whose record has no time", async () => {
    const { groupsFile, startUnrecordedGroup } = await setUp();
    const [group, pid] = await startUnrecordedGroup("sleep 30 >/dev/null & echo $$ $!");
    await vi.waitFor(() => expect(isRunning(group!)).toBe(false));
    await writeFile(groupsFile, `${group}\n`);

    await stopLeftoverGroups(groupsFile);

    expect(isRunning(pid!)).toBe(true);
  });

  it("ignores a record of pid 1", async () => {
    const { groupsFile } = await setUp();
    await writeFile(groupsFile, `1 ${Date.now()}\n`);

    expect(await stopLeftoverGroups(groupsFile)).toEqual([]);
  });

  it("removes the lock files when no group of the run runs", async () => {
    const { writeLockFiles, folder, groupsFile, lockFiles } = await setUp();
    await writeLockFiles();
    await new HostSandbox(folder, groupsFile, lockFiles).assignWorkspace("host");

    expect(await Promise.all(lockFiles.map(pathExists))).toEqual([false, false]);
  });

  it("refuses the give-back while a group of the run runs", async () => {
    const { writeLockFiles, folder, groupsFile, lockFiles, startGroup } = await setUp();
    await writeLockFiles();
    const sandbox = new HostSandbox(folder, groupsFile, lockFiles);
    await startGroup(sandbox);

    await expect(sandbox.assignWorkspace("host")).rejects.toThrow(
      "a process of the run still runs",
    );
  });

  it("refuses the give-back while a recorded group runs that it cannot match to its record", async () => {
    const { writeLockFiles, folder, groupsFile, lockFiles } = await setUp();
    await writeLockFiles();
    const sandbox = new HostSandbox(folder, join(folder, "other.groups"), lockFiles);
    const controller = new AbortController();
    const child = await sandbox.spawn(["sh", "-c", "echo $$; sleep 30"], {
      signal: controller.signal,
    });
    const pid = Number(await firstLine(child.stdout));
    onTestFinished(async () => {
      controller.abort();
      await child.stopped;
    });
    await writeFile(groupsFile, `${pid} 0\n`);

    await expect(
      new HostSandbox(folder, groupsFile, lockFiles).assignWorkspace("host"),
    ).rejects.toThrow("a process of the run still runs");
  });

  it("keeps the lock files while a group of the run runs", async () => {
    const { writeLockFiles, folder, groupsFile, lockFiles, startGroup } = await setUp();
    await writeLockFiles();
    const sandbox = new HostSandbox(folder, groupsFile, lockFiles);
    await startGroup(sandbox);

    await sandbox.assignWorkspace("host").catch(() => {});

    expect(await Promise.all(lockFiles.map(pathExists))).toEqual([true, true]);
  });

  it("reads an output of more than 1 MiB", async () => {
    const { stagedRepo } = await setUp();
    const git = await stagedRepo("large.txt", "x".repeat(2 * 1024 * 1024));

    const blob = await git.run("rev-parse", ":large.txt");

    expect((await git.readBlob(blob)).length).toBe(2 * 1024 * 1024);
  });

  it("rejects an output that is longer than the limit of the call", async () => {
    const { stagedRepo } = await setUp();
    const git = await stagedRepo("notes.md", "notes\n");

    await expect(git.listStagedFiles(4)).rejects.toThrow("git diff failed");
  });

  it("rejects when it looks for a root in a missing folder", async () => {
    const { folder } = await setUp();
    await expect(hostGit(join(folder, "missing")).findRoot()).rejects.toThrow("ENOENT");
  });

  it("rejects when git cannot start in the folder", async () => {
    const { folder } = await setUp();
    await expect(hostGit(join(folder, "missing")).run("status")).rejects.toThrow("ENOENT");
  });
});
