import { dirname } from "node:path";

import { expect } from "@playwright/test";

import { test } from "../utils";

const noSettings = { labels: [], allowedAgents: null };

test.describe("halinka runner", () => {
  test("joins with an enrollment token from stdin", async ({ halinka }) => {
    const server = await halinka.start();
    const { token } = await server.postJson<{ token: string }>(
      "/api/runners/enrollment-tokens",
      noSettings,
    );

    const runner = await halinka.runRemoteRunner(server, "build-1", ["--enroll-stdin"]);
    runner.input(`${token}\n`);

    await runner.expectOutput(`runner "build-1" connected to ${server.url}`);
    expect(await server.get("/api/runners")).toMatchObject([
      { isConnected: true },
      { name: "build-1", isConnected: true },
    ]);
  });

  test("joins after an Admin approves its code", async ({ halinka }) => {
    const server = await halinka.start();
    const runner = await halinka.runRemoteRunner(server, "build-1");
    const [, code] = await runner.waitForMatch(/Code: (\w{4}-\w{4})/);

    await server.postJson(`/api/runners/requests/${code}/approve`, {
      name: "gpu-box",
      ...noSettings,
    });

    await runner.expectOutput(`connected to ${server.url}`);
    expect(await server.get("/api/runners")).toMatchObject([{}, { name: "gpu-box" }]);
  });

  test("refuses to start next to halinka start with the home of this machine", async ({
    halinka,
  }) => {
    const server = await halinka.start();
    await server.expectRunnerConnected();

    const runner = halinka.run(["runner", "--server", server.url]);

    await runner.expectOutput("Another Halinka process runs as the runner");
    await runner.expectExit(1);
  });

  test("exits with the reason when an Admin revokes it", async ({ halinka }) => {
    const server = await halinka.start();
    const { token } = await server.postJson<{ token: string }>(
      "/api/runners/enrollment-tokens",
      noSettings,
    );
    const runner = await halinka.runRemoteRunner(server, "build-1", ["--enroll-stdin"]);
    runner.input(token);
    await runner.expectOutput("connected");

    await server.postJson("/api/runners/2/revoke", {});

    await runner.expectOutput("The server ended the connection: An Admin revoked this runner");
    await runner.expectExit(78);
  });

  test("exits when the server refuses the token", async ({ halinka }) => {
    const server = await halinka.start();
    const runner = await halinka.runRemoteRunner(server, "build-1", ["--enroll-stdin"]);

    runner.input("not-a-token");

    await runner.expectOutput(
      "refused the runner: The enrollment token is not valid, used or expired",
    );
    await runner.expectExit(1);
  });

  const startApprovedRunner = async (
    halinka: Parameters<Parameters<typeof test>[2]>[0]["halinka"],
    args: string[],
  ) => {
    const server = await halinka.start();
    const { token } = await server.postJson<{ token: string }>("/api/runners/enrollment-tokens", {
      labels: [],
      allowedAgents: null,
    });
    const runner = await halinka.runRemoteRunner(server, "build-1", ["--enroll-stdin", ...args]);
    runner.input(token);
    await runner.expectOutput('runner "build-1" connected');
    return server;
  };

  test("refuses a repo outside its folders", async ({ halinka }) => {
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: local\n",
    });
    const server = await startApprovedRunner(halinka, ["--root", await halinka.createFolder()]);

    const answer = await server.post("/api/repos", { runnerId: 2, path: repo.path });

    expect(((await answer.json()) as { message: string }).message).toContain(
      "outside the folders of this runner",
    );
  });

  test("registers a repo in its folders", async ({ halinka }) => {
    const repo = await halinka.createRepo({
      ".halinka/config.yml": "schema_version: 1\nserver: local\n",
    });
    const server = await startApprovedRunner(halinka, ["--root", dirname(repo.path)]);

    await server.postJson("/api/repos", { runnerId: 2, path: repo.path });

    expect(await server.get("/api/repos")).toMatchObject([{ path: repo.path }]);
  });

  test("refuses a root that is not a folder", async ({ halinka }) => {
    const runner = halinka.run(["runner", "--server", "http://127.0.0.1:1", "--root", "/no/such"]);

    await runner.expectOutput("--root /no/such is not a folder.");
    await runner.expectExit(1);
  });

  test("refuses an http URL to another machine", async ({ halinka }) => {
    const runner = halinka.run(["runner", "--server", "http://halinka.example.com"]);

    await runner.expectOutput("without TLS. Use an https URL.");
    await runner.expectExit(1);
  });
});
