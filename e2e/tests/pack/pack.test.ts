import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { HalinkaProcess } from "../utils/halinkaProcess";
import { TestRepo } from "../utils/testRepo";

const repoRoot = join(import.meta.dirname, "../../..");

const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("HALINKA_") && name !== "DATABASE_URL",
    ),
  );

test.describe.configure({ mode: "serial", timeout: 300_000 });

test.describe("the packed package", () => {
  let root: string;
  let installed: string;

  const processes: HalinkaProcess[] = [];

  const halinka = (args: string[], cwd: string) => {
    const started = new HalinkaProcess(
      spawn(join(installed, "node_modules/.bin/halinka"), args, {
        cwd,
        env: { ...cleanEnv(), HALINKA_HOME: join(root, "home"), NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      }),
    );
    processes.push(started);
    return started;
  };

  test.beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "halinka-pack-")));
    installed = join(root, "installed");
    await mkdir(installed);
    const run = (command: string, args: string[], cwd: string) =>
      execFileSync(command, args, { cwd, env: cleanEnv(), stdio: "inherit" });
    run("pnpm", ["turbo", "build", "--filter=halinka"], repoRoot);
    run("pnpm", ["--filter", "halinka", "pack", "--pack-destination", root], repoRoot);
    const [tarball] = (await readdir(root)).filter((name) => name.endsWith(".tgz"));
    run(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(root, tarball!)],
      installed,
    );
  });

  test.afterAll(async () => {
    await Promise.all(processes.map((each) => each.kill()));
    await rm(root, { recursive: true, force: true });
  });

  test("prints the version and the build id", async () => {
    const cli = halinka(["--version"], root);

    await cli.waitForMatch(/^\S+ \(build [0-9a-f]{12}\)$/m);
    await cli.expectExit(0);
  });

  test("writes the repo files with init", async () => {
    const repo = await TestRepo.create(join(root, "init-repo"), {});

    const cli = halinka(
      ["init", "--server", "local", "--devcontainer", "none", "--yes"],
      repo.path,
    );

    await cli.expectExit(0);
    await repo.expectFile(".halinka/config.yml", "schema_version: 1\nserver: local\n");
  });

  test("runs a workflow on a server that serves the API and the portal", async () => {
    const repo = await TestRepo.create(join(root, "run-repo"), {
      ".halinka/config.yml": "schema_version: 1\nserver: local\n",
      ".halinka/workflows/hello.yml":
        "schema_version: 1\nname: Hello\nsteps:\n  - { id: hello, type: shell, run: echo hello }\n",
    });
    const server = halinka(["start", "--port", "0", "--runs-in", "worktree"], repo.path);
    const url = await server.waitForUrl();

    const health = await fetch(`${url}/api/health`);
    const portal = await (await fetch(url)).text();
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(portal)?.[1];
    const script = await fetch(`${url}${asset}`);
    const run = halinka(["run", "hello"], repo.path);

    await run.expectExit(0);
    expect(health.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
    server.interrupt();
    await server.expectExit(0);
  });
});
