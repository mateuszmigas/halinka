import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect } from "@playwright/test";

const cliFolder = join(import.meta.dirname, "../../../apps/cli");
const tsxLoader = pathToFileURL(createRequire(join(cliFolder, "package.json")).resolve("tsx")).href;

type SpawnOptions = { cwd: string; home: string; bin: string; env: Record<string, string> };

const running = new Set<ChildProcess>();

// A fixture teardown that times out skips `TestHalinka.dispose`.
process.once("exit", () => {
  for (const child of running) {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {}
  }
});

export class HalinkaProcess {
  private output = "";
  private readonly exitCode: Promise<number | null>;
  private readonly closed: Promise<unknown>;

  constructor(private readonly child: ChildProcess) {
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (this.output += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (this.output += chunk));
    running.add(child);
    child.once("exit", () => running.delete(child));
    this.exitCode = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    this.closed = new Promise((resolve) => child.once("close", resolve));
  }

  static spawn(args: string[], { cwd, home, bin, env }: SpawnOptions) {
    // No tsx CLI: it sends each group signal to the CLI a second time.
    const child = spawn(
      process.execPath,
      ["--import", tsxLoader, join(cliFolder, "src/main.ts"), ...args],
      {
        cwd,
        env: {
          ...process.env,
          ...env,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          HALINKA_HOME: home,
          NO_COLOR: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      },
    );
    return new HalinkaProcess(child);
  }

  input(text: string) {
    this.child.stdin?.end(text);
    return this;
  }

  async expectOutput(text: string) {
    await expect.poll(() => this.output).toContain(text);
    return this;
  }

  async expectNoOutputAtClose(text: string) {
    await this.closed;
    expect(this.output).not.toContain(text);
    return this;
  }

  async expectExit(code: number) {
    expect(await this.exitCode, this.output).toBe(code);
    return this;
  }

  async waitForMatch(pattern: RegExp) {
    await expect.poll(() => this.output).toMatch(pattern);
    return this.output.match(pattern)!;
  }

  async waitForUrl() {
    // A start is slow when many tests start at the same time.
    await expect.poll(() => this.output, { timeout: 30_000 }).toMatch(/listening on http:\/\/\S+/);
    return this.output.match(/listening on (http:\/\/\S+)/)![1]!;
  }

  interrupt() {
    process.kill(-this.child.pid!, "SIGINT");
    return this;
  }

  async kill() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    process.kill(-this.child.pid!, "SIGKILL");
    await this.exitCode;
  }
}
