import { mkdir } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { text } from "node:stream/consumers";

import { loadOrCreateRunnerKey } from "@halinka/runner/runnerKey";
import { listenForTest } from "@halinka/runner/testing";
import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it } from "vitest";

import { updateToServerBuild } from "./runnerSelfUpdate";
import { canTryBuild, recordUpdateFailure } from "./runnerVersions";

const ownBuildId = "a".repeat(64);
const serverBuildId = "b".repeat(64);

const manifestOf = (buildId: string) => ({
  version: "0.0.1",
  buildId,
  protocolVersion: 20,
  package: { sha512: "0", size: 4 },
});

const setUp = async (buildId = serverBuildId, packageStatus = 200) => {
  const reports: { status: string; reason: string }[] = [];
  let packageRequests = 0;
  const answer = async (request: IncomingMessage, response: ServerResponse) => {
    const json = { "content-type": "application/json" };
    if (request.url === "/api/runner/manifest") {
      return response.writeHead(200, json).end(JSON.stringify(manifestOf(buildId)));
    }
    if (request.url === "/api/runner/package") {
      packageRequests++;
      return response.writeHead(packageStatus).end("data");
    }
    if (request.url === "/api/runner/status") {
      reports.push(JSON.parse(await text(request)));
      return response.writeHead(200, json).end('{"result":"accepted"}');
    }
    response.writeHead(404).end();
  };
  const server = await listenForTest((request, response) => void answer(request, response));
  const home = await tempFolder();
  await mkdir(join(home, "versions"));
  const key = await loadOrCreateRunnerKey(home);
  const update = () =>
    updateToServerBuild({ server, key, home, buildId: ownBuildId, isInsecure: false });
  return { home, update, reports, packageRequests: () => packageRequests };
};

describe("updateToServerBuild", () => {
  it("installs nothing when the runner runs the build of the server", async () => {
    const { update, packageRequests } = await setUp(ownBuildId);

    expect([await update(), packageRequests()]).toEqual(["current", 0]);
  });

  it("reports a failed install to the server", async () => {
    const { update, reports } = await setUp();

    await update();

    expect(reports).toMatchObject([
      { status: "update_failed", reason: expect.stringContaining("sha512") },
    ]);
  });

  it("counts no failure of the build when the server does not give its package", async () => {
    const { home, update } = await setUp(serverBuildId, 503);

    const outcome = await update();

    expect([outcome, await canTryBuild(home, serverBuildId)]).toEqual(["unreachable", true]);
  });

  it("downloads nothing after two failed tries of the build", async () => {
    const { home, update, packageRequests } = await setUp();
    await recordUpdateFailure(home, serverBuildId);
    await recordUpdateFailure(home, serverBuildId);

    await update();

    expect(packageRequests()).toBe(0);
  });
});
