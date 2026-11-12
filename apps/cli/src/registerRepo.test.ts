import { randomBytes } from "node:crypto";

import { testBuild } from "@halinka/protocol/testing";
import { loadOrCreateRunnerKey } from "@halinka/runner/runnerKey";
import { Server } from "@halinka/server";
import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { registerRepo } from "./registerRepo";

const setUp = async () => {
  const home = await tempFolder();
  vi.stubEnv("HALINKA_HOME", home);
  const server = new Server({
    port: 0,
    build: testBuild,
    dbLocation: { kind: "pglite" },
    masterKey: randomBytes(32),
  });
  onTestFinished(async () => {
    await server.stop();
  });
  await server.start();
  return { home, server };
};

describe("registerRepo", () => {
  it("gives a hint when this machine has no runner key", async () => {
    const { server } = await setUp();

    const registration = await registerRepo(server.url, "/code/app");

    expect(registration).toEqual({
      ok: false,
      problems: [
        {
          kind: "no_runner_key",
          reason: `This machine is not a runner of the server. Make it a runner: halinka runner --server ${server.url}`,
        },
      ],
    });
  });

  it("gives a hint when the server does not know the runner key of this machine", async () => {
    const { home, server } = await setUp();
    await loadOrCreateRunnerKey(home);

    const registration = await registerRepo(server.url, "/code/app", { isListedFirst: true });

    expect(registration).toEqual({
      ok: false,
      problems: [
        {
          kind: "refused",
          reason: `This machine is not a runner of the server. Make it a runner: halinka runner --server ${server.url}`,
        },
      ],
    });
  });
});
