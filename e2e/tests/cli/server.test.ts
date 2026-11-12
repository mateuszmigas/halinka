import { join } from "node:path";

import { pathExists } from "@halinka/utils/fs";
import { expect } from "@playwright/test";

import { test } from "../utils";

test.describe("halinka server", () => {
  test("runs the server without a runner", async ({ halinka }) => {
    const server = await halinka.startServer();

    expect(await server.get("/api/runners")).toEqual([]);

    await server.stop();
  });

  test("refuses to start next to halinka start with the same home", async ({ halinka }) => {
    await halinka.start();

    const server = halinka.run(["server", "--port", "0"]);

    await server.expectOutput("Another Halinka process runs the server");
    await server.expectExit(1);
  });

  test("refuses a login without a master key", async ({ halinka }) => {
    halinka.setLogin("https://halinka.example.com");
    halinka.removeEnv("HALINKA_MASTER_KEY");

    const cli = halinka.run(["server", "--port", "0"]);

    await cli.expectOutput("A server with a login needs HALINKA_MASTER_KEY");
    await cli.expectExit(1);
  });

  test("names a port in use without a stack trace", async ({ halinka }) => {
    const server = await halinka.startServer();
    const home = join(await halinka.createFolder(), "home");

    const cli = halinka.run(["server", "--port", new URL(server.url).port], undefined, home);

    await cli.expectExit(1);
    await cli.expectOutput("address already in use");
    await cli.expectNoOutputAtClose("    at ");
  });

  test("removes its URL file at a stop", async ({ halinka }) => {
    const server = await halinka.startServer();
    const urlFile = join(halinka.home, "server.json");
    expect(await pathExists(urlFile)).toBe(true);

    await server.stop();

    expect(await pathExists(urlFile)).toBe(false);
  });

  test("connects a runner with the same home", async ({ halinka }) => {
    const server = await halinka.startServer();
    const runner = halinka.run(["runner", "--server", server.url, "--runs-in", "worktree"]);
    const [, code] = await runner.waitForMatch(/Code: (\w{4}-\w{4})/);

    await server.postJson(`/api/runners/requests/${code}/approve`, {
      name: "same-home",
      labels: [],
      allowedAgents: null,
    });

    await runner.expectOutput(`connected to ${server.url}`);
  });
});
