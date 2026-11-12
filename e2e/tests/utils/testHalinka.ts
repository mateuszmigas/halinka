import { type ChildProcess, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";

import { type FakeTurn, fakeAcpAgentCommand, fakeAgentPrompt } from "@halinka/agents/testing";
import { type AgentPresetId, agentPresets } from "@halinka/presets";
import { pathExists } from "@halinka/utils/fs";
import { expect } from "@playwright/test";

import { HalinkaProcess } from "./halinkaProcess";
import { HalinkaServer } from "./halinkaServer";
import { TestRepo } from "./testRepo";

const agentWorkflow = (turns: FakeTurn[]) =>
  [
    "schema_version: 1",
    "name: Agent",
    "steps:",
    `  - { id: work, type: agent, agent: claude-code, require_changes: false, prompt: ${JSON.stringify(fakeAgentPrompt(turns))} }`,
    "",
  ].join("\n");

const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

export class TestHalinka {
  readonly home: string;
  private readonly bin: string;
  private readonly processes: HalinkaProcess[] = [];
  private readonly holders: ChildProcess[] = [];
  private readonly fakeServers: Server[] = [];
  private env: Record<string, string> = {};

  constructor(private readonly root: string) {
    this.home = join(root, "home");
    this.bin = join(root, "bin");
  }

  // The lease stays longer than the runner sync interval (5 s).
  shortenLeases() {
    this.env = { HALINKA_LEASE_SECONDS: "10", HALINKA_SWEEP_SECONDS: "1" };
  }

  setLogin(publicUrl: string) {
    this.env = {
      ...this.env,
      HALINKA_PUBLIC_URL: publicUrl,
      HALINKA_AUTH_SECRET: "s".repeat(32),
      HALINKA_GITHUB_CLIENT_ID: "test-client",
      HALINKA_GITHUB_CLIENT_SECRET: "test-secret",
      HALINKA_ADMIN_GITHUB: "octo",
      HALINKA_MASTER_KEY: randomBytes(32).toString("base64"),
    };
  }

  setEnv(name: string, value: string) {
    this.env = { ...this.env, [name]: value };
  }

  removeEnv(name: string) {
    const { [name]: _, ...rest } = this.env;
    this.env = rest;
  }

  setServerUrl(url: string) {
    this.env = { ...this.env, HALINKA_SERVER_URL: url };
  }

  run(args: string[], cwd = this.root, home = this.home) {
    const process = HalinkaProcess.spawn(args, { cwd, home, bin: this.bin, env: this.env });
    this.processes.push(process);
    return process;
  }

  async start(args: string[] = [], cwd = this.root) {
    const process = this.run(["start", "--port", "0", "--runs-in", "worktree", ...args], cwd);
    return new HalinkaServer(process, await process.waitForUrl());
  }

  async startServer() {
    const process = this.run(["server", "--port", "0"]);
    return new HalinkaServer(process, await process.waitForUrl());
  }

  async readLocalRunnerName() {
    const key = JSON.parse(await readFile(join(this.home, "runner.json"), "utf8")) as {
      name: string;
    };
    return key.name;
  }

  async runRemoteRunner(server: HalinkaServer, name: string, args: string[] = []) {
    const home = join(this.root, `home-${name}`);
    await mkdir(home, { recursive: true });
    const { x, d } = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
    const key = { name, publicKey: x, privateKey: d };
    await writeFile(join(home, "runner.json"), JSON.stringify(key), { mode: 0o600 });
    return this.run(
      ["runner", "--server", server.url, "--runs-in", "worktree", ...args],
      this.root,
      home,
    );
  }

  async startInRepo(workflows: Record<string, string>) {
    const files = Object.entries(workflows).map(([name, source]) => [
      `.halinka/workflows/${name}`,
      source,
    ]);
    const repo = await this.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: local\n",
      ...Object.fromEntries(files),
    });
    const server = await this.start([], repo.path);
    await server.expectRepoRegistered(repo.path);
    return { repo, server };
  }

  async startWithAgent(turns: FakeTurn[]) {
    await this.installFakeAgent("claude-code");
    return this.startInRepo({ "agent.yml": agentWorkflow(turns) });
  }

  init(repo: TestRepo, args: string[] = []) {
    return this.run(["init", ...args], repo.path);
  }

  createRepo(files: Record<string, string> = {}) {
    return TestRepo.create(join(this.root, "repo"), files);
  }

  // Call it after the run starts: the runner makes the folder then.
  async findWorkspaceFolder(workflowRunId: number) {
    const workspaces = join(this.home, "workspaces");
    await expect.poll(() => readdir(workspaces).catch(() => [])).toHaveLength(1);
    const [serverId] = await readdir(workspaces);
    return join(workspaces, serverId!, `run-${workflowRunId}`);
  }

  async createFolder() {
    const path = join(this.root, "folder");
    await mkdir(path);
    return path;
  }

  async installBrokenAgent(preset: AgentPresetId) {
    await this.writeBin(
      agentPresets[preset].command[0]!,
      'echo "The key is not valid" >&2; exit 1',
    );
  }

  async installFakeAgent(preset: AgentPresetId) {
    const fake = fakeAcpAgentCommand.map(shellQuote).join(" ");
    const agentFolder = shellQuote(join(this.root, "fake-agent"));
    await this.writeBin(
      agentPresets[preset].command[0]!,
      `HALINKA_FAKE_AGENT_DIR=${agentFolder} exec ${fake} "$@"`,
    );
  }

  // The Docker check holds the start of a devcontainer runner open.
  async installSlowDocker() {
    await this.writeBin("docker", "sleep 30");
  }

  async installCodexThatLogsIn(auth: object) {
    await this.writeCodex(
      `printf '%s' ${shellQuote(JSON.stringify(auth))} > "$CODEX_HOME/auth.json"`,
    );
  }

  async installCodexThatFails() {
    await this.writeCodex("exit 1");
  }

  async readLastCodexHome() {
    return readFile(join(this.root, "codex-home"), "utf8");
  }

  async readCodexLogin() {
    return JSON.parse(await readFile(join(this.home, "logins", "codex.json"), "utf8")) as unknown;
  }

  // A live process that holds the lock, as a runner that refreshes the login does.
  holdCodexLoginLock() {
    return this.holdLock(join(this.home, "logins", "codex.lock"));
  }

  holdRunnerLock() {
    return this.holdLock(join(this.home, "runner.lock"));
  }

  private async holdLock(path: string) {
    const holder = spawn("sleep", ["60"]);
    this.holders.push(holder);
    await once(holder, "spawn");
    const pid = holder.pid!;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ pid, instanceId: "runner" }));
    return holder;
  }

  // A fake HTTP server on loopback. `dispose` stops it.
  async startFakeServer(listener: RequestListener) {
    const server = createServer(listener);
    this.fakeServers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async expectDatabase() {
    expect(await pathExists(join(this.home, "db", "PG_VERSION"))).toBe(true);
    return this;
  }

  // A test can check that the command removed the CODEX_HOME of the fake.
  private async writeCodex(script: string) {
    const home = shellQuote(join(this.root, "codex-home"));
    await this.writeBin("codex", `printf '%s' "$CODEX_HOME" > ${home}\n${script}`);
  }

  // So `halinka open` opens no browser on the machine of the test.
  async installFakeBrowser(openedFile: string) {
    await this.writeBin("open", `echo "$1" > "${openedFile}"`);
    await this.writeBin("xdg-open", `echo "$1" > "${openedFile}"`);
  }

  private async writeBin(name: string, script: string) {
    await mkdir(this.bin, { recursive: true });
    await writeFile(join(this.bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }

  async dispose() {
    for (const holder of this.holders) holder.kill("SIGKILL");
    for (const server of this.fakeServers) {
      server.closeAllConnections();
      server.close();
    }
    await Promise.all(this.processes.map((process) => process.kill()));
    // A step has its own process group, so it can still write after the server stops.
    await rm(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
