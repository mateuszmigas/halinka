import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { access, link, lstat, mkdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";

import type { Sandbox } from "@halinka/sandbox";
import { HostSandbox } from "@halinka/sandbox/host";
import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it, onTestFinished } from "vitest";

import { FileReportChannel } from "./fileReportChannel";

const shape = { outcomes: ["approve", "reject"] };

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const envValue = (channel: FileReportChannel, name: string) =>
  channel.mcpServer.env.find((variable) => variable.name === name)!.value;

const sandboxWithExec = (folder: string, exec: Sandbox["exec"]): Sandbox =>
  Object.assign(new HostSandbox(folder), { exec });

const setUp = async () => {
  const folder = await tempFolder();
  const channel = await FileReportChannel.create(new HostSandbox(folder), shape);
  onTestFinished(() => channel.close());
  const reportFile = envValue(channel, "HALINKA_REPORT_FILE");
  const questionFile = envValue(channel, "HALINKA_QUESTION_FILE");
  return { folder, channel, reportFile, questionFile };
};

describe("FileReportChannel", () => {
  it("reads the report", async () => {
    const { channel, reportFile } = await setUp();
    await writeFile(reportFile, JSON.stringify({ summary: "Done", outcome: "approve" }));

    const read = await channel.read();

    expect(read).toEqual({ report: { summary: "Done", outcome: "approve" } });
  });

  it("gives the problems of a report that does not match the schema", async () => {
    const { channel, reportFile } = await setUp();
    await writeFile(reportFile, JSON.stringify({ summary: "Done", outcome: "merge" }));

    const read = await channel.read();

    expect(read).toEqual({ reportProblems: expect.stringContaining("outcome") });
  });

  it("gives a problem when the report is not JSON", async () => {
    const { channel, reportFile } = await setUp();
    await writeFile(reportFile, "Done");

    const read = await channel.read();

    expect(read).toEqual({ reportProblems: "The report is not JSON" });
  });

  it("reads the questions", async () => {
    const { channel, questionFile } = await setUp();
    const questions = [{ question: "Which database?", header: "Database" }];
    await writeFile(questionFile, JSON.stringify({ questions }));

    const read = await channel.read();

    expect(read).toEqual({ questions: [{ ...questions[0], multiSelect: false }] });
  });

  it("reads the report and the questions of one turn", async () => {
    const { channel, reportFile, questionFile } = await setUp();
    const questions = [{ question: "Which database?", header: "Database", multiSelect: false }];
    await writeFile(reportFile, JSON.stringify({ summary: "Done", outcome: "approve" }));
    await writeFile(questionFile, JSON.stringify({ questions }));

    const read = await channel.read();

    expect(read).toEqual({ report: { summary: "Done", outcome: "approve" }, questions });
  });

  it("gives a problem when the questions are not JSON", async () => {
    const { channel, questionFile } = await setUp();
    await writeFile(questionFile, "Which database?");

    const read = await channel.read();

    expect(read).toEqual({ questionProblems: "The question is not JSON" });
  });

  it("gives the problems of questions that do not match the schema", async () => {
    const { channel, questionFile } = await setUp();
    await writeFile(questionFile, JSON.stringify({ questions: [] }));

    const read = await channel.read();

    expect(read).toEqual({ questionProblems: expect.stringContaining("questions") });
  });

  it("gives the report script the outcome names and the outputs of the step", async () => {
    const { folder } = await setUp();
    const outputs = { files: { type: "array" as const, items: "string" as const } };
    const shaped = await FileReportChannel.create(new HostSandbox(folder), {
      outcomes: { approve: "ok", reject: "fail" },
      outputs,
    });

    expect(JSON.parse(envValue(shaped, "HALINKA_REPORT_SHAPE"))).toEqual({
      outcomes: ["approve", "reject"],
      outputs,
    });
    await shaped.close();
  });

  it("gives the question schema without multiSelect as a required field", async () => {
    const { channel } = await setUp();
    const inputSchema = JSON.parse(envValue(channel, "HALINKA_QUESTION_SCHEMA"));

    expect(inputSchema.properties.questions.items.required).toEqual(["question", "header"]);
  });

  it("deletes the report and the questions when it reads them", async () => {
    const { channel, reportFile, questionFile } = await setUp();
    await writeFile(reportFile, JSON.stringify({ summary: "Done", outcome: "approve" }));
    await writeFile(questionFile, JSON.stringify({ questions: [] }));
    await channel.read();

    const read = await channel.read();

    expect(read).toEqual({});
  });

  it("deletes a report that is a link, not its target", async () => {
    const { folder, channel, reportFile } = await setUp();
    const target = join(folder, "secret.json");
    await writeFile(target, "{}");
    await symlink(target, reportFile);

    await channel.read();

    expect(await Promise.all([exists(reportFile), exists(target)])).toEqual([false, true]);
  });

  it("deletes its folder on close", async () => {
    const { channel, reportFile } = await setUp();
    await channel.close();

    await expect(access(dirname(reportFile))).rejects.toThrow();
  });

  it("reads the report and the questions in one call", async () => {
    const { folder } = await setUp();
    const host = new HostSandbox(folder);
    const calls: string[][] = [];
    const sandbox = sandboxWithExec(folder, (command, options) => {
      calls.push(command);
      return host.exec(command, options);
    });
    const counted = await FileReportChannel.create(sandbox, shape);
    calls.length = 0;

    await counted.read();

    expect(calls).toHaveLength(1);
    await counted.close();
  });

  it("makes its sandbox calls without network", async () => {
    const { folder } = await setUp();
    const host = new HostSandbox(folder);
    const networks: unknown[] = [];
    const sandbox = sandboxWithExec(folder, (command, options) => {
      networks.push(options?.network);
      return host.exec(command, options);
    });
    const counted = await FileReportChannel.create(sandbox, shape);

    await counted.read();
    await counted.close();

    expect(networks).toEqual([undefined, undefined, undefined]);
  });

  it("rejects a read that fails", async () => {
    const { folder } = await setUp();
    const host = new HostSandbox(folder);
    const sandbox = sandboxWithExec(folder, (command, options) =>
      command[0] === "node"
        ? Promise.resolve({ exitCode: 127, stdout: "", stderr: "node: not found" })
        : host.exec(command, options),
    );
    const failing = await FileReportChannel.create(sandbox, shape);

    await expect(failing.read()).rejects.toThrow(
      "Halinka could not read the report: node: not found",
    );
    await failing.close();
  });

  it("rejects a read whose output is not a list of files", async () => {
    const { folder } = await setUp();
    const host = new HostSandbox(folder);
    const sandbox = sandboxWithExec(folder, (command, options) =>
      command[0] === "node"
        ? Promise.resolve({ exitCode: 0, stdout: "Welcome", stderr: "" })
        : host.exec(command, options),
    );
    const failing = await FileReportChannel.create(sandbox, shape);

    await expect(failing.read()).rejects.toThrow(
      "Halinka could not read the report: The output of the read is not JSON",
    );
    await failing.close();
  });

  it("gives a problem when the report is larger than 1 MiB", async () => {
    const { channel, reportFile } = await setUp();
    await writeFile(reportFile, JSON.stringify({ summary: "x".repeat(1024 * 1024) }));

    const read = await channel.read();

    expect(read).toEqual({ reportProblems: "The report is larger than 1 MiB" });
  });

  it("reads a report of exactly 1 MiB", async () => {
    const { channel, reportFile } = await setUp();
    const report = JSON.stringify({ summary: "x", outcome: "approve" });
    await writeFile(reportFile, report.padEnd(1024 * 1024, " "));

    const read = await channel.read();

    expect(read).toEqual({ report: { summary: "x", outcome: "approve" } });
  });

  it("gives a problem when the report is a link", async () => {
    const { folder, channel, reportFile } = await setUp();
    const target = join(folder, "secret.json");
    await writeFile(target, JSON.stringify({ summary: "Secret", outcome: "approve" }));
    await symlink(target, reportFile);

    const read = await channel.read();

    expect(read).toEqual({ reportProblems: "The report is a link" });
  });

  it("gives a problem when the report has a second link", async () => {
    const { folder, channel, reportFile } = await setUp();
    const target = join(folder, "secret.json");
    await writeFile(target, JSON.stringify({ summary: "Secret", outcome: "approve" }));
    await link(target, reportFile);

    const read = await channel.read();

    expect(read).toEqual({ reportProblems: "The report has more than one link" });
  });

  it("gives a problem when the report is not readable", async () => {
    const { channel, reportFile } = await setUp();
    await writeFile(reportFile, "{}", { mode: 0o000 });

    const read = await channel.read();

    expect(read).toEqual({ reportProblems: "The report cannot be opened (EACCES)" });
  });

  it("gives a problem when the report is a socket", async () => {
    const { channel, reportFile } = await setUp();
    const server = createServer().listen(reportFile);
    await once(server, "listening");

    try {
      const read = await channel.read();

      expect(read).toEqual({
        reportProblems: expect.stringMatching(/^The report cannot be opened/),
      });
    } finally {
      server.close();
    }
  });

  it("rejects a read when it cannot delete a file", async () => {
    const { channel, questionFile } = await setUp();
    await mkdir(questionFile);

    await expect(channel.read()).rejects.toThrow("Halinka could not read the report");
  });

  it("deletes the question file when it cannot delete the report file", async () => {
    const { channel, reportFile, questionFile } = await setUp();
    await mkdir(reportFile);
    await writeFile(questionFile, JSON.stringify({ questions: [] }));

    await channel.read().catch(() => {});

    expect(await exists(questionFile)).toBe(false);
  });

  it("gives a problem when the report is a FIFO", async () => {
    const { channel, reportFile } = await setUp();
    execFileSync("mkfifo", [reportFile]);

    const read = await channel.read();

    expect(read).toEqual({ reportProblems: "The report is not a regular file" });
  });

  it("deletes its folder when the install fails after the folder exists", async () => {
    const { folder } = await setUp();
    const host = new HostSandbox(folder);
    const servers: string[] = [];
    const sandbox = sandboxWithExec(folder, async (command, options) => {
      const server = command.find((arg) => arg.endsWith("/report-result.mjs"));
      if (!server) return host.exec(command, options);
      servers.push(server);
      await host.exec(["mkdir", "-p", dirname(server)]);
      return { exitCode: 1, stdout: "", stderr: "No space left on device" };
    });

    await expect(FileReportChannel.create(sandbox, shape)).rejects.toThrow(
      "No space left on device",
    );
    await expect(access(dirname(servers[0]!))).rejects.toThrow();
  });

  it("rejects a report shape larger than 64 KiB before it installs the report server", async () => {
    const { folder } = await setUp();
    const outputs = Object.fromEntries(
      Array.from({ length: 4000 }, (_, index) => [`output_${index}`, "string" as const]),
    );
    const sandbox = sandboxWithExec(folder, async () => {
      throw new Error("The channel must not use the sandbox");
    });

    await expect(FileReportChannel.create(sandbox, { outputs })).rejects.toThrow(
      "The report shape of the step is larger than 64 KiB",
    );
  });

  it("rejects when the sandbox cannot install the report server", async () => {
    const { folder } = await setUp();
    const sandbox = sandboxWithExec(folder, async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Permission denied",
    }));

    await expect(FileReportChannel.create(sandbox, shape)).rejects.toThrow(
      "Halinka could not install the report server: Permission denied",
    );
  });
});
