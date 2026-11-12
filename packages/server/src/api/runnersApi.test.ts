import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { invalidInput, protocolVersion } from "@halinka/protocol";
import {
  createKeyPair,
  type ProbeFields,
  type RunnerSigner,
  signedProbe,
  signedRegistration,
  signedStatus,
  signerOf,
} from "@halinka/protocol/keys";
import { testBuild } from "@halinka/protocol/testing";
import { tempFolder } from "@halinka/utils/testing";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { runnerEnrollments, runners } from "../db/schema";
import { readRunnerPackage } from "../runnerPackage";
import {
  createConnectedTestServer,
  createTestServer,
  recordChanges,
  registerTestRunner,
  setUpTestDb,
  syncRunner,
  testApiUrl,
  testRunnerPackage,
  worktreeRunner,
} from "../testing";

const testDb = setUpTestDb();

const host = { name: "build-1", os: "linux", arch: "x64" };

const registrationOf = (name = host.name) =>
  signedRegistration(signerOf(createKeyPair()), { ...host, name });

const noSettings: { labels: string[]; allowedAgents: string[] | null } = {
  labels: [],
  allowedAgents: null,
};

const setUp = async () => {
  const server = await createTestServer(testDb());
  const { api } = server;
  const enrollWithToken = async (registration = registrationOf(), settings = noSettings) => {
    const { token } = await api.runners.createEnrollmentToken(settings);
    return api.runner.enroll({ token, ...registration });
  };
  const requestCode = async (registration = registrationOf()) => {
    const answer = await api.runner.register(registration);
    if (answer.status !== "pending") throw new Error("The registration is not pending");
    return answer.userCode;
  };
  const enrolledSigner = async () => {
    const signer = signerOf(createKeyPair());
    await enrollWithToken(signedRegistration(signer, host));
    return signer;
  };
  const enrolledRunner = async () =>
    (await api.runners.list()).find(({ name }) => name === host.name);
  return { ...server, enrollWithToken, requestCode, enrolledSigner, enrolledRunner };
};

// A runner that can update and runs another build than the server.
const otherBuildRunner = {
  ...worktreeRunner,
  canUpdate: true,
  build: { version: "0.0.1", id: "other-build" },
};

const statusOf = (signer: RunnerSigner, reason: string) =>
  signedStatus(signer, {
    serverUrl: testApiUrl,
    sentAt: Date.now(),
    status: "update_failed",
    buildId: "other-build",
    reason,
  });

const probeOf = (signer: RunnerSigner, fields: Partial<ProbeFields> = {}) =>
  signedProbe(signer, {
    serverUrl: testApiUrl,
    protocolVersion,
    build: testBuild,
    sentAt: Date.now(),
    ...fields,
  });

const queuedRun = async () => {
  const context = await createConnectedTestServer(testDb());
  return { ...context, changes: recordChanges(context.bus, await context.queue()) };
};

describe("GET /api/runners", () => {
  it("lists the runners and whether each one is connected", async () => {
    const { api, runnerId } = await createTestServer(testDb());
    const other = await registerTestRunner(testDb(), "other");

    expect(await api.runners.list()).toMatchObject([
      { id: runnerId, name: "local", publicKey: "local-key", state: "active", isConnected: true },
      { id: other.id, name: "other", publicKey: "other-key", state: "active", isConnected: false },
    ]);
  });

  it("lists the runs that a runner holds", async () => {
    const { api, claimOne, queue } = await createConnectedTestServer(testDb());
    await queue();
    const claimed = await claimOne();

    expect((await api.runners.list())[0]?.heldRunIds).toEqual([claimed.lease.workflowRunId]);
  });

  it("marks a runner with the build of the server as current", async () => {
    const { api, plane } = await createTestServer(testDb());

    await syncRunner(plane, worktreeRunner);

    expect(await api.runners.list()).toMatchObject([
      { version: testBuild.version, buildId: testBuild.id, buildStatus: "current" },
    ]);
  });

  it("marks a runner with another build as out of date", async () => {
    const { api, plane } = await createTestServer(testDb());

    await syncRunner(plane, { ...worktreeRunner, build: { version: "0.0.2", id: "other-build" } });

    expect(await api.runners.list()).toMatchObject([
      { version: "0.0.2", buildId: "other-build", buildStatus: "outdated" },
    ]);
  });

  it("marks a runner of another protocol version as update needed", async () => {
    const { api, enrolledSigner, enrolledRunner } = await setUp();
    const signer = await enrolledSigner();

    await api.runner.probe(probeOf(signer, { protocolVersion: protocolVersion - 1 }));

    expect((await enrolledRunner())?.buildStatus).toBe("update_needed");
  });

  it("stores no build for an accepted probe", async () => {
    const { api, enrolledSigner, enrolledRunner } = await setUp();

    await api.runner.probe(probeOf(await enrolledSigner()));

    expect((await enrolledRunner())?.version).toBeUndefined();
  });

  it("keeps the build status of a runner after a probe that its key did not sign", async () => {
    const { api, enrolledSigner, enrolledRunner } = await setUp();
    const probe = probeOf(await enrolledSigner(), { protocolVersion: protocolVersion - 1 });

    await api.runner.probe({ ...probe, sentAt: probe.sentAt + 1 }).catch(() => {});

    expect((await enrolledRunner())?.buildStatus).toBeUndefined();
  });

  it("gives no build for a runner that never synced", async () => {
    const { api } = await createTestServer(testDb());

    const [runner] = await api.runners.list();

    expect([runner?.version, runner?.buildId, runner?.buildStatus]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("POST /api/runner/probe", () => {
  it("accepts a known key of the protocol version of the server", async () => {
    const { api, enrolledSigner } = await setUp();

    expect(await api.runner.probe(probeOf(await enrolledSigner()))).toEqual({
      result: "accepted",
    });
  });

  it("accepts the pending new key of a runner", async () => {
    const { api, enrolledRunner, enrolledSigner } = await setUp();
    await enrolledSigner();
    const { token } = await api.runners.createEnrollmentToken({
      runnerId: (await enrolledRunner())!.id,
    });
    const newKey = signerOf(createKeyPair());
    await api.runner.enroll({ token, ...signedRegistration(newKey, host) });

    expect(await api.runner.probe(probeOf(newKey))).toEqual({ result: "accepted" });
  });

  it("tells a runner that an update waits for it", async () => {
    const { api, enrolledSigner, enrolledRunner } = await setUp();
    const signer = await enrolledSigner();
    await testDb()
      .update(runners)
      .set({ canUpdate: true, updateRequest: "when_idle" })
      .where(eq(runners.id, (await enrolledRunner())!.id));

    expect(await api.runner.probe(probeOf(signer))).toEqual({
      result: "accepted",
      isUpdateRequested: true,
    });
  });

  it("answers unknown for a key that the server does not know", async () => {
    const { api } = await setUp();

    expect(await api.runner.probe(probeOf(signerOf(createKeyPair())))).toEqual({
      result: "unknown",
    });
  });

  it("answers update needed to a runner of another protocol version", async () => {
    const { api, enrolledSigner } = await setUp();

    const answer = await api.runner.probe(
      probeOf(await enrolledSigner(), { protocolVersion: protocolVersion - 1 }),
    );

    expect(answer).toMatchObject({ result: "update_needed" });
  });

  it("refuses the key of a revoked runner", async () => {
    const { api, enrolledSigner, enrolledRunner } = await setUp();
    const signer = await enrolledSigner();
    await api.runners.revoke({ id: (await enrolledRunner())!.id });

    expect(await api.runner.probe(probeOf(signer))).toMatchObject({ result: "refused" });
  });

  it.each([
    ["before", -6],
    ["after", 6],
  ])("answers clock skew to a probe sent 6 min %s the time of the server", async (_, minutes) => {
    const { api, enrolledSigner } = await setUp();

    const answer = await api.runner.probe(
      probeOf(await enrolledSigner(), { sentAt: Date.now() + minutes * 60 * 1000 }),
    );

    expect(answer).toMatchObject({ result: "clock_skew" });
  });

  it("answers update needed to an unknown key of another protocol version", async () => {
    const { api } = await setUp();

    const answer = await api.runner.probe(
      probeOf(signerOf(createKeyPair()), { protocolVersion: protocolVersion - 1 }),
    );

    expect(answer).toMatchObject({ result: "update_needed" });
  });

  it("refuses a probe whose public key is not an Ed25519 key", async () => {
    const { api, enrolledSigner } = await setUp();

    await expect(
      api.runner.probe({ ...probeOf(await enrolledSigner()), publicKey: "x" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a probe for another server", async () => {
    const { api, enrolledSigner } = await setUp();

    const answer = await api.runner.probe(
      probeOf(await enrolledSigner(), { serverUrl: "https://other.example.com" }),
    );

    expect(answer).toMatchObject({ result: "refused" });
  });

  it("refuses a probe that the key did not sign", async () => {
    const { api, enrolledSigner } = await setUp();
    const probe = probeOf(await enrolledSigner());

    await expect(
      api.runner.probe({ ...probe, build: { ...testBuild, id: "other" } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("POST /api/runner/status", () => {
  it("ends the update request of the runner", async () => {
    const { api, enrolledSigner, enrolledRunner } = await setUp();
    const signer = await enrolledSigner();
    await testDb()
      .update(runners)
      .set({ canUpdate: true, updateRequest: "when_idle" })
      .where(eq(runners.id, (await enrolledRunner())!.id));

    await api.runner.reportStatus(statusOf(signer, "npm install failed"));

    expect(await enrolledRunner()).not.toHaveProperty("updateRequest");
  });

  it("keeps the first reason when the same build fails again", async () => {
    const { api, enrolledSigner, enrolledRunner } = await setUp();
    const signer = await enrolledSigner();
    await api.runner.reportStatus(statusOf(signer, "npm install failed"));

    await api.runner.reportStatus(statusOf(signer, "The update failed twice"));

    expect((await enrolledRunner())?.updateFailure).toBe("npm install failed");
  });

  it("stores at most 2000 characters of the reason", async () => {
    const { api, enrolledSigner, enrolledRunner } = await setUp();

    await api.runner.reportStatus(statusOf(await enrolledSigner(), "x".repeat(3000)));

    expect((await enrolledRunner())?.updateFailure).toHaveLength(2000);
  });

  it("shows the reason of a failed update in the runner list", async () => {
    const { api, enrolledSigner, enrolledRunner } = await setUp();
    const signer = await enrolledSigner();

    await api.runner.reportStatus(
      signedStatus(signer, {
        serverUrl: testApiUrl,
        sentAt: Date.now(),
        status: "update_failed",
        buildId: "other-build",
        reason: "npm install failed",
      }),
    );

    expect((await enrolledRunner())?.updateFailure).toBe("npm install failed");
  });
});

describe("GET /api/runner/manifest", () => {
  it("gives the sha512 and the size of the runner package", async () => {
    const folder = await tempFolder();
    await writeFile(join(folder, "halinka.tgz"), "package bytes");
    const runnerPackage = await readRunnerPackage(join(folder, "halinka.tgz"));
    const { api } = await createTestServer(testDb(), { runnerPackage });

    expect((await api.runner.manifest()).package).toEqual({
      sha512: createHash("sha512").update("package bytes").digest("hex"),
      size: 13,
    });
  });

  it("gives the build and the protocol version of the server", async () => {
    const { api } = await createTestServer(testDb());

    expect(await api.runner.manifest()).toEqual({
      version: testBuild.version,
      buildId: testBuild.id,
      protocolVersion,
    });
  });
});

describe("POST /api/runners/{id}/update", () => {
  it("refuses a runner that cannot update itself", async () => {
    const { api, plane, runnerId } = await createTestServer(testDb(), {
      runnerPackage: testRunnerPackage,
    });
    await syncRunner(plane, worktreeRunner);

    await expect(api.runners.requestUpdate({ id: runnerId })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("refuses an update on a server with no package for runners", async () => {
    const { api, plane, runnerId } = await createTestServer(testDb());
    await syncRunner(plane, otherBuildRunner);

    await expect(api.runners.requestUpdate({ id: runnerId })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("refuses a runner that runs the build of the server", async () => {
    const { api, plane, runnerId } = await createTestServer(testDb(), {
      runnerPackage: testRunnerPackage,
    });
    await syncRunner(plane, { ...worktreeRunner, canUpdate: true });

    await expect(api.runners.requestUpdate({ id: runnerId })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("answers not found for an unknown runner", async () => {
    const { api } = await createTestServer(testDb(), { runnerPackage: testRunnerPackage });

    await expect(api.runners.requestUpdate({ id: 99 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("wakes the runner at an update request", async () => {
    const { api, plane, runnerId, commands } = await createTestServer(testDb(), {
      runnerPackage: testRunnerPackage,
    });
    await syncRunner(plane, otherBuildRunner);
    commands.wake.mockClear();

    await api.runners.requestUpdate({ id: runnerId });

    await vi.waitFor(() => expect(commands.wake).toHaveBeenCalled());
  });

  it("shows the update request in the runner list", async () => {
    const { api, plane, runnerId } = await createTestServer(testDb(), {
      runnerPackage: testRunnerPackage,
    });
    await syncRunner(plane, otherBuildRunner);

    await api.runners.requestUpdate({ id: runnerId });

    expect(await api.runners.list()).toMatchObject([{ updateRequest: "when_idle" }]);
  });
});

describe("DELETE /api/runners/{id}/update", () => {
  it("turns auto-update off, which would ask again at the next sync", async () => {
    const { api, plane, runnerId } = await createTestServer(testDb(), {
      runnerPackage: testRunnerPackage,
    });
    await api.runners.update({ id: runnerId, hasAutoUpdate: true });
    await syncRunner(plane, otherBuildRunner);

    await api.runners.cancelUpdate({ id: runnerId });

    expect((await api.runners.list())[0]?.hasAutoUpdate).toBe(false);
  });

  it("cancels the update request", async () => {
    const { api, plane, runnerId } = await createTestServer(testDb(), {
      runnerPackage: testRunnerPackage,
    });
    await syncRunner(plane, otherBuildRunner);
    await api.runners.requestUpdate({ id: runnerId });

    await api.runners.cancelUpdate({ id: runnerId });

    expect((await api.runners.list())[0]).not.toHaveProperty("updateRequest");
  });
});

describe("POST /api/runner/enroll", () => {
  it("enrolls a runner with the host, the key and the settings of the token", async () => {
    const { api, enrollWithToken } = await setUp();
    const registration = registrationOf();

    await enrollWithToken(registration, { labels: ["gpu"], allowedAgents: ["codex"] });

    expect((await api.runners.list()).at(-1)).toMatchObject({
      ...host,
      publicKey: registration.publicKey,
      labels: ["gpu"],
      allowedAgents: ["codex"],
    });
  });

  it("refuses an enrollment token that enrolled a runner before", async () => {
    const { api } = await setUp();
    const { token } = await api.runners.createEnrollmentToken(noSettings);
    await api.runner.enroll({ token, ...registrationOf("first") });

    await expect(api.runner.enroll({ token, ...registrationOf("second") })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "The enrollment token is not valid, used or expired",
    });
  });

  it("refuses an enrollment token that expired", async () => {
    const { api } = await setUp();
    const { token } = await api.runners.createEnrollmentToken(noSettings);
    await testDb()
      .update(runnerEnrollments)
      .set({ expiresAt: sql`now()` });

    await expect(api.runner.enroll({ token, ...registrationOf() })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("keeps the enrollment token unused when another runner has the name", async () => {
    const { api } = await setUp();
    const { token } = await api.runners.createEnrollmentToken(noSettings);
    await expect(api.runner.enroll({ token, ...registrationOf("local") })).rejects.toMatchObject({
      code: "CONFLICT",
    });

    await expect(api.runner.enroll({ token, ...registrationOf("build-2") })).resolves.toEqual({
      name: "build-2",
    });
  });

  it("keeps the enrollment token unused for a runner that has the key", async () => {
    const { api, enrollWithToken } = await setUp();
    const registration = registrationOf();
    await enrollWithToken(registration);
    const { token } = await api.runners.createEnrollmentToken(noSettings);

    await api.runner.enroll({ token, ...registration });

    await expect(api.runner.enroll({ token, ...registrationOf("build-2") })).resolves.toEqual({
      name: "build-2",
    });
  });

  it("refuses a registration that the key did not sign", async () => {
    const { enrollWithToken } = await setUp();

    await expect(enrollWithToken({ ...registrationOf(), name: "other" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "The signature of the registration is not valid",
    });
  });

  it("refuses a key that is not in the canonical form", async () => {
    const { enrollWithToken } = await setUp();
    const registration = registrationOf();

    await expect(
      enrollWithToken({ ...registration, publicKey: `${registration.publicKey}=` }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("gives a runner a pending new key with a token for the runner", async () => {
    const { api, runnerId } = await setUp();
    const { token } = await api.runners.createEnrollmentToken({ runnerId });
    const registration = registrationOf("build-1");

    await api.runner.enroll({ token, ...registration });

    expect(await api.runner.register(registration)).toEqual({ status: "approved" });
  });
});

describe("POST /api/runners/enrollment-tokens", () => {
  it("refuses a label that is not valid, at its field", async () => {
    const { api } = await setUp();

    await expect(
      api.runners.createEnrollmentToken({ labels: ["GPU"], allowedAgents: null }),
    ).rejects.toMatchObject({ data: { issues: [{ path: ["labels"] }] } });
  });

  it("refuses a token for a revoked runner", async () => {
    const { api, runnerId } = await setUp();
    await api.runners.revoke({ id: runnerId });

    await expect(api.runners.createEnrollmentToken({ runnerId })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("POST /api/runners/requests/{userCode}/approve", () => {
  it("approves a request as a new key of a runner", async () => {
    const { api, runnerId, requestCode } = await setUp();
    const registration = registrationOf();
    const userCode = await requestCode(registration);

    await api.runners.approveRequest({ userCode, runnerId });

    expect(await api.runner.register(registration)).toEqual({ status: "approved" });
    expect(await api.runners.list()).toHaveLength(1);
  });

  it("approves a request with the name and the settings of the Admin", async () => {
    const { api, requestCode } = await setUp();
    const registration = registrationOf();
    const userCode = await requestCode(registration);

    await api.runners.approveRequest({
      userCode,
      name: "gpu-box",
      ...noSettings,
      labels: ["gpu"],
    });

    expect(await api.runner.register(registration)).toEqual({ status: "approved" });
    expect((await api.runners.list()).at(-1)).toMatchObject({ name: "gpu-box", labels: ["gpu"] });
  });

  it("refuses an approval with the name of another runner", async () => {
    const { api, requestCode } = await setUp();
    const userCode = await requestCode();

    await expect(
      api.runners.approveRequest({ userCode, name: "local", ...noSettings }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a second approval of a request", async () => {
    const { api, requestCode } = await setUp();
    const userCode = await requestCode();
    await api.runners.approveRequest({ userCode, name: "build-1", ...noSettings });

    await expect(
      api.runners.approveRequest({ userCode, name: "build-2", ...noSettings }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("POST /api/runner/registrations", () => {
  it("refuses the pending key that a newer enrollment replaced", async () => {
    const { api, runnerId } = await setUp();
    const enrollKey = async (registration: ReturnType<typeof registrationOf>) => {
      const { token } = await api.runners.createEnrollmentToken({ runnerId });
      await api.runner.enroll({ token, ...registration });
    };
    const first = registrationOf();
    await enrollKey(first);
    await enrollKey(registrationOf());

    await expect(api.runner.register(first)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "A newer key of this runner replaced this key",
    });
  });

  it("gives the same device code to each repeat of a registration", async () => {
    const { requestCode } = await setUp();
    const registration = registrationOf();
    const first = await requestCode(registration);

    const second = await requestCode(registration);

    expect(second).toBe(first);
  });

  it("refuses a registration with the key of a revoked runner", async () => {
    const { api, enrollWithToken } = await setUp();
    const registration = registrationOf();
    await enrollWithToken(registration);
    const enrolled = (await api.runners.list()).find(
      ({ publicKey }) => publicKey === registration.publicKey,
    );
    await api.runners.revoke({ id: enrolled?.id ?? 0 });

    await expect(api.runner.register(registration)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("limits the registrations of one address to 60 a minute", async () => {
    const { api } = await setUp();
    const registration = registrationOf();
    for (let count = 0; count < 60; count++) await api.runner.register(registration);

    await expect(api.runner.register(registration)).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
  });

  it("tells a refused client when to try again", async () => {
    const { api, app } = await setUp();
    const registration = registrationOf();
    for (let count = 0; count < 60; count++) await api.runner.register(registration);

    const response = await app.fetch(
      new Request(`${testApiUrl}/api/runner/registrations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(registration),
      }),
    );

    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("GET /api/runners/requests/{userCode}", () => {
  it("shows the machine of a request to the Admin", async () => {
    const { api, requestCode } = await setUp();
    const userCode = await requestCode();

    expect(await api.runners.findRequest({ userCode: userCode.toLowerCase() })).toMatchObject({
      userCode,
      hostName: "build-1",
      os: "linux",
      arch: "x64",
    });
  });

  it("finds no request for an unknown code", async () => {
    const { api } = await setUp();

    await expect(api.runners.findRequest({ userCode: "BCDF-GHJK" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("PATCH /api/runners/{id}", () => {
  it("stores the labels sorted and once", async () => {
    const { api, runnerId } = await setUp();

    expect(await api.runners.update({ id: runnerId, labels: ["x", "gpu", "x"] })).toMatchObject({
      labels: ["gpu", "x"],
    });
  });

  it("refuses an allowed agent that does not exist", async () => {
    const { api, runnerId } = await setUp();

    await expect(
      api.runners.update({ id: runnerId, allowedAgents: ["other"] }),
    ).rejects.toMatchObject({ data: { issues: [{ path: ["allowedAgents"] }] } });
  });

  it("signals a state change of a queued run when the settings change", async () => {
    const { api, runnerId, changes } = await queuedRun();

    await api.runners.update({ id: runnerId, labels: ["gpu"] });

    expect(changes).toEqual(["state"]);
  });

  it("signals no state change of a queued run when another runner changes", async () => {
    const { api, changes } = await queuedRun();
    const other = await registerTestRunner(testDb(), "other");

    await api.runners.update({ id: other.id, labels: ["gpu"] });

    expect(changes).toEqual([]);
  });

  it("refuses a change of a revoked runner", async () => {
    const { api, runnerId } = await setUp();
    await api.runners.revoke({ id: runnerId });

    await expect(api.runners.update({ id: runnerId, state: "active" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("POST /api/runners/{id}/revoke", () => {
  it("signals a state change of a queued run when the runner is revoked", async () => {
    const { api, runnerId, changes } = await queuedRun();

    await api.runners.revoke({ id: runnerId });

    expect(changes).toEqual(["state"]);
  });

  it("closes the connections of the runner", async () => {
    const { api, runnerId, closed } = await setUp();

    await api.runners.revoke({ id: runnerId });

    expect(closed).toHaveBeenCalledWith(runnerId, "An Admin revoked this runner");
  });
});

describe("GET /api/runners/{id}/folders", () => {
  it("passes the path to the runner", async () => {
    const { api, runnerId, commands } = await setUp();

    await api.runners.folders({ id: runnerId, path: "/code" });

    expect(commands.listFolders).toHaveBeenCalledWith({ path: "/code" });
  });

  it("asks for the home folder when no path is given", async () => {
    const { api, runnerId, commands } = await setUp();

    await api.runners.folders({ id: runnerId });

    expect(commands.listFolders).toHaveBeenCalledWith({ path: undefined });
  });

  it("answers 400 for a relative path", async () => {
    const { api, runnerId, commands } = await setUp();

    await expect(api.runners.folders({ id: runnerId, path: "code" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(commands.listFolders).not.toHaveBeenCalled();
  });

  it("answers 400 with the message of the runner when it cannot open the folder", async () => {
    const { api, runnerId, commands } = await setUp();
    commands.listFolders.mockRejectedValueOnce(invalidInput("Halinka cannot open /code"));

    await expect(api.runners.folders({ id: runnerId, path: "/code" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Halinka cannot open /code",
    });
  });

  it("answers 503 when the runner is not connected", async () => {
    const { api, runnerId, disconnect } = await setUp();
    disconnect();

    await expect(api.runners.folders({ id: runnerId })).rejects.toMatchObject({
      code: "RUNNER_OFFLINE",
      status: 503,
    });
  });

  it("answers 404 for a runner that does not exist", async () => {
    const { api } = await setUp();

    await expect(api.runners.folders({ id: 99 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
