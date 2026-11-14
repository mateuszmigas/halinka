import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Duplex } from "node:stream";

import type { RunnerCommands } from "@halinka/protocol";
import { createKeyPair, signedRegistration, signerOf } from "@halinka/protocol/keys";
import { testBuild } from "@halinka/protocol/testing";
import { connectStream, WebSocketClientTransport } from "@halinka/protocol/webSocket";
import { tempFolder } from "@halinka/utils/testing";
import { sql } from "drizzle-orm";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { AuthConfig } from "./auth/config";
import { createApiClient, runSshPath } from "./client";
import { type DbLocation, openDb } from "./db/client";
import { createRepositories, inTransaction } from "./db/repositories";
import { workflowRuns, workflowSchedules } from "./db/schema";
import { Server } from "./server";
import { devcontainerConfig, devcontainerRunner, testAuthConfig, worktreeRunner } from "./testing";

const config = "schema_version: 1\nserver: local\n";

const inProcessRunnerId = 1;

const signer = signerOf(createKeyPair());
const localRunner = { name: "local", publicKey: signer.publicKey };
const buildWorkflow =
  "schema_version: 1\nname: Build\nsteps:\n  - id: build\n    type: shell\n    run: ls\n";

const runnerCommands = () => ({
  wake: vi.fn(async () => {}),
  readRepo: vi.fn<RunnerCommands["readRepo"]>(async ({ repoPath }) => ({
    realPath: repoPath,
    head: "abc",
    files: {
      ".halinka/config.yml": { source: config, hash: "" },
      ".halinka/workflows/build.yml": { source: buildWorkflow, hash: "" },
    },
  })),
  writeRepoFile: vi.fn<RunnerCommands["writeRepoFile"]>(async () => ({ hash: "" })),
  readCommitFile: vi.fn<RunnerCommands["readCommitFile"]>(async () => undefined),
  listFolders: vi.fn<RunnerCommands["listFolders"]>(async () => ({
    path: "/",
    isRepo: false,
    folders: [],
    isTruncated: false,
  })),
  listDevcontainers: vi.fn<RunnerCommands["listDevcontainers"]>(async () => []),
  setUpRepo: vi.fn<RunnerCommands["setUpRepo"]>(async () => ({ files: [] })),
  pushBranch: vi.fn<RunnerCommands["pushBranch"]>(async () => {}),
  openRelay: vi.fn<RunnerCommands["openRelay"]>(async () => {}),
  openPullRequest: vi.fn<RunnerCommands["openPullRequest"]>(async () => ({
    url: "https://github.com/acme/app/pull/1",
    isCreated: true,
  })),
});

const createDataFolder = async () => ({ kind: "pglite", dataFolder: await tempFolder() }) as const;

type AcceptOptions = {
  commands?: RunnerCommands;
  close?: (reason: string) => void;
  publicKey?: string;
};

const setUp = async ({
  dbLocation = { kind: "pglite" },
  auth,
}: { dbLocation?: DbLocation; auth?: AuthConfig } = {}) => {
  const server = new Server({
    port: 0,
    build: testBuild,
    dbLocation,
    masterKey: randomBytes(32),
    auth,
  });
  onTestFinished(() => server.stop());
  await server.start();
  await server.registerLocalRunner(localRunner);

  const post = (path: string, body: unknown) =>
    fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const registerRepo = () => post("/api/repos", { runnerId: inProcessRunnerId, path: "/code/app" });

  const accept = (
    instanceId: string,
    {
      commands = runnerCommands(),
      close = () => {},
      publicKey = localRunner.publicKey,
    }: AcceptOptions = {},
  ) => server.acceptRunner({ instanceId, publicKey, commands, close });

  const enrollNewKey = async () => {
    const tokenAnswer = await post("/api/runners/enrollment-tokens", {
      runnerId: inProcessRunnerId,
    });
    const { token } = (await tokenAnswer.json()) as { token: string };
    const newSigner = signerOf(createKeyPair());
    const host = { name: "local", os: "linux", arch: "x64" };
    await post("/api/runner/enroll", { token, ...signedRegistration(newSigner, host) });
    return newSigner.publicKey;
  };

  const connectOverWebSocket = async (commands: RunnerCommands = runnerCommands()) => {
    const connection = await new WebSocketClientTransport(server.url, signer).connect(
      { instanceId: "runner-1" },
      commands,
    );
    onTestFinished(() => connection.close());
    return connection;
  };

  return { server, post, registerRepo, accept, enrollNewKey, connectOverWebSocket };
};

const watchQueuedRun = async ({ server, registerRepo }: Awaited<ReturnType<typeof setUp>>) => {
  await registerRepo();
  const api = createApiClient(server.url);
  const { id } = await api.runs.create({ repoId: 1, workflow: "build" });
  const stream = await api.runs.watch({ id });
  await stream.next();
  return stream;
};

const devcontainerFiles = {
  ".halinka/config.yml": { source: devcontainerConfig, hash: "" },
  ".halinka/workflows/build.yml": { source: buildWorkflow, hash: "" },
};

// A finished run whose container runs, on a runner that opens each relay it gets.
const setUpRunningContainer = async () => {
  const fixture = await setUp();
  const { server, post, registerRepo, connectOverWebSocket } = fixture;
  const commands = runnerCommands();
  commands.readRepo.mockImplementation(async ({ repoPath }) => ({
    realPath: repoPath,
    head: "abc",
    files: devcontainerFiles,
  }));
  const runnerStream = Promise.withResolvers<Duplex>();
  commands.openRelay.mockImplementation(async ({ relayId }) => {
    runnerStream.resolve(await connection.openRelay(relayId));
  });
  const connection = await connectOverWebSocket(commands);
  await registerRepo();
  await post("/api/runs", { repoId: 1, workflow: "build" });
  const { claimed } = await connection.plane.sync({
    held: [],
    capacity: 1,
    capabilities: devcontainerRunner,
  });
  await connection.plane.finishRun(claimed[0]!.lease, "succeeded");
  await fetch(`${server.url}/api/runs/1/sandbox`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec: "running" }),
  });
  await connection.plane.reportSandbox({
    workflowRunId: 1,
    generation: 3,
    observed: "running",
  });
  return { ...fixture, connection, runnerStream: runnerStream.promise };
};

const firstChunk = async (stream: Duplex) => String((await once(stream, "data"))[0]);

describe("Server", () => {
  it("sends the stream of a queued run a state change when the runner disconnects", async () => {
    const fixture = await setUp();
    const { ended } = await fixture.accept("first");
    const stream = await watchQueuedRun(fixture);

    ended();

    expect(await stream.next()).toMatchObject({ value: { type: "state" } });
  });

  it("sends the stream of a queued run a state change when the runner connects", async () => {
    const fixture = await setUp();
    const { ended } = await fixture.accept("first");
    const stream = await watchQueuedRun(fixture);
    ended();
    await stream.next();

    await fixture.accept("second");

    expect(await stream.next()).toMatchObject({ value: { type: "state" } });
  });

  it("logs no error when a runner disconnects during a stop", async () => {
    const { server, accept } = await setUp();
    const { ended } = await accept("first");
    const logged = vi.spyOn(console, "error");

    ended();
    await server.stop();

    expect(logged).not.toHaveBeenCalled();
  });

  it("starts no read of queued runs after a stop", async () => {
    const { server, accept } = await setUp();
    const { ended } = await accept("first");
    const logged = vi.spyOn(console, "error");
    await server.stop();

    ended();
    await new Promise(setImmediate);

    expect(logged).not.toHaveBeenCalled();
  });

  it("listens on this machine only", async () => {
    const { server } = await setUp();

    expect(server.http.address()).toMatchObject({ address: "127.0.0.1" });
  });

  it("sends commands to the newest process of the runner", async () => {
    const { registerRepo, accept } = await setUp();
    const first = runnerCommands();
    const second = runnerCommands();
    await accept("first", { commands: first });
    await accept("second", { commands: second });

    await registerRepo();

    expect(first.readRepo).not.toHaveBeenCalled();
    expect(second.readRepo).toHaveBeenCalledOnce();
  });

  it("sends commands to a process that connects again after a newer one", async () => {
    const { registerRepo, accept } = await setUp();
    const again = runnerCommands();
    await accept("first");
    await accept("second");
    await accept("first", { commands: again });

    await registerRepo();

    expect(again.readRepo).toHaveBeenCalledOnce();
  });

  it("keeps the other processes of the runner when one disconnects", async () => {
    const { registerRepo, accept } = await setUp();
    const first = runnerCommands();
    await accept("first", { commands: first });
    const { ended } = await accept("second");

    ended();
    await registerRepo();

    expect(first.readRepo).toHaveBeenCalledOnce();
  });

  it("keeps the new connection of a process when its old connection ends", async () => {
    const { registerRepo, accept } = await setUp();
    const second = runnerCommands();
    const { ended } = await accept("runner-1");
    await accept("runner-1", { commands: second });

    ended();
    await registerRepo();

    expect(second.readRepo).toHaveBeenCalledOnce();
  });

  it("refuses a runner whose key it does not know", async () => {
    const { server } = await setUp();

    const accepting = server.acceptRunner({
      instanceId: "runner-1",
      publicKey: "unknown-key",
      commands: runnerCommands(),
      close: () => {},
    });

    await expect(accepting).rejects.toMatchObject({ code: "refused" });
  });

  it("closes the sessions of the old key when the new key of a runner connects", async () => {
    const { accept, enrollNewKey } = await setUp();
    const closed = vi.fn();
    await accept("runner-1", { close: closed });
    const newKey = await enrollNewKey();

    await accept("runner-2", { publicKey: newKey });

    expect(closed).toHaveBeenCalledWith("A newer key of this runner replaced this key");
  });

  it("refuses a sync of the old key after the new key of the runner connected", async () => {
    const { accept, enrollNewKey } = await setUp();
    const { plane } = await accept("runner-1");
    await accept("runner-2", { publicKey: await enrollNewKey() });

    await expect(
      plane.sync({ held: [], capacity: 1, capabilities: worktreeRunner }),
    ).rejects.toMatchObject({
      code: "refused",
    });
  });

  it("accepts the new key after another of its processes made it current", async () => {
    const { accept, enrollNewKey } = await setUp();
    const newKey = await enrollNewKey();
    await accept("runner-2", { publicKey: newKey });

    await expect(accept("runner-3", { publicKey: newKey })).resolves.toHaveProperty("plane");
  });

  it("keeps the sessions of the new key open when another of its processes connects", async () => {
    const { accept, enrollNewKey } = await setUp();
    const newKey = await enrollNewKey();
    const closed = vi.fn();
    await accept("runner-2", { close: closed, publicKey: newKey });

    await accept("runner-3", { publicKey: newKey });

    expect(closed).not.toHaveBeenCalled();
  });

  it("keeps the old key of a runner until its new key connects", async () => {
    const { accept, enrollNewKey } = await setUp();
    await enrollNewKey();

    await expect(accept("runner-1")).resolves.toHaveProperty("plane");
  });

  it("refuses the old key after the new key of the runner connected", async () => {
    const { accept, enrollNewKey } = await setUp();
    await accept("runner-2", { publicKey: await enrollNewKey() });

    await expect(accept("runner-1")).rejects.toMatchObject({
      message: "A newer key of this runner replaced this key",
    });
  });

  it("refuses a runner that an Admin revoked", async () => {
    const { post, accept } = await setUp();
    await post(`/api/runners/${inProcessRunnerId}/revoke`, {});

    await expect(accept("runner-1")).rejects.toMatchObject({
      code: "refused",
      message: "An Admin revoked this runner",
    });
  });

  it("gives the local runner the same runner at the next start", async () => {
    const { server } = await setUp();

    const registered = await server.registerLocalRunner({ ...localRunner, name: "renamed" });

    expect(registered).toMatchObject({ id: inProcessRunnerId, name: "local" });
  });

  it("keeps the server id across two starts on one database", async () => {
    const dbLocation = await createDataFolder();
    const first = await setUp({ dbLocation });
    const { serverId } = await first.accept("first");
    await first.server.stop();

    const second = await setUp({ dbLocation });

    expect((await second.accept("second")).serverId).toBe(serverId);
  });

  it("keeps the server settings across two starts on one database", async () => {
    const dbLocation = await createDataFolder();
    const first = await setUp({ dbLocation });
    await createApiClient(first.server.url).serverSettings.update({ isUpdateCheckOn: false });
    await first.server.stop();

    const second = await setUp({ dbLocation });

    expect(await createApiClient(second.server.url).serverSettings.get()).toEqual({
      isUpdateCheckOn: false,
    });
  });

  it("gives another server id to another database", async () => {
    const first = await setUp();
    const { serverId } = await first.accept("first");
    await first.server.stop();

    const second = await setUp();

    expect((await second.accept("second")).serverId).not.toBe(serverId);
  });

  it("gives the refusal of a local runner whose key a newer key replaced", async () => {
    const { server, accept, enrollNewKey } = await setUp();
    await accept("runner-2", { publicKey: await enrollNewKey() });

    expect(await server.registerLocalRunner(localRunner)).toMatchObject({
      refusal: "A newer key of this runner replaced this key",
    });
  });

  it("registers no local runner when another runner has the name", async () => {
    const { server } = await setUp();

    const registered = await server.registerLocalRunner({ ...localRunner, publicKey: "other-key" });

    expect(registered).toBeUndefined();
  });

  it("closes the old connection of a process that connects again", async () => {
    const { accept } = await setUp();
    const close = vi.fn();
    await accept("runner-1", { close });

    await accept("runner-1");

    expect(close).toHaveBeenCalledOnce();
  });

  it("accepts runners over WebSocket on its port", async () => {
    const { connectOverWebSocket } = await setUp();
    const connection = await connectOverWebSocket();

    const answer = await connection.plane.sync({
      held: [],
      capacity: 0,
      capabilities: worktreeRunner,
    });

    expect(answer.claimed).toEqual([]);
  });

  it("ends the runner connections when it stops", async () => {
    const { server, connectOverWebSocket } = await setUp();
    const connection = await connectOverWebSocket();

    await server.stop();

    await expect(
      connection.plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner }),
    ).rejects.toMatchObject({
      code: "connection_closed",
    });
  });

  it("calls the commands of a runner that has no own properties, as over the network", async () => {
    const { registerRepo, accept } = await setUp();
    const commands = runnerCommands();
    const remote = new Proxy({} as RunnerCommands, {
      get: (_, name) => commands[name as keyof RunnerCommands],
    });
    await accept("runner-1", { commands: remote });

    const response = await registerRepo();

    expect(response.status).toBe(200);
  });

  it("wakes every process of the run's runner", async () => {
    const { post, registerRepo, accept } = await setUp();
    const first = runnerCommands();
    const second = runnerCommands();
    await accept("first", { commands: first });
    await accept("second", { commands: second });
    await registerRepo();

    await post("/api/runs", { repoId: 1, workflow: "build" });

    expect(first.wake).toHaveBeenCalledOnce();
    expect(second.wake).toHaveBeenCalledOnce();
  });

  it("sees a connected runner for a run with no runner", async () => {
    const dbLocation = await createDataFolder();
    const { db, close } = await openDb(dbLocation);
    const repositories = createRepositories(db);
    const repo = await repositories.repo.createGitHub({ name: "acme/app", githubRepoId: 100 });
    const snapshot = await repositories.workflowSnapshot.findOrCreate({
      repoId: repo.id,
      path: ".halinka/workflows/build.yml",
      files: {},
      resolved: { name: "Build", steps: [] },
      runsOn: [],
      agents: [],
    });
    const run = await repositories.workflowRun.create({
      repoId: repo.id,
      runnerId: null,
      workflowSnapshotId: snapshot.id,
      inputs: {},
      baseSha: "abc",
      definitionSha: "abc",
    });
    await close();
    const { server, accept } = await setUp({ dbLocation });
    const api = createApiClient(server.url);
    const waitReason = async () => (await api.runs.get({ id: run!.id })).waitReason;
    expect(await waitReason()).toBe("No connected runner can take the run");

    await accept("first");

    expect(await waitReason()).toBeUndefined();
  });

  it("gives each connection the plane of its process", async () => {
    const { post, registerRepo, accept } = await setUp();
    const first = await accept("first");
    const second = await accept("second");
    await registerRepo();
    await post("/api/runs", { repoId: 1, workflow: "build" });
    const [claimed] = (
      await first.plane.sync({ held: [], capacity: 1, capabilities: worktreeRunner })
    ).claimed;
    if (!claimed) throw new Error("No run was claimed");

    await second.plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner });

    expect(
      (
        await first.plane.sync({
          held: [claimed.lease],
          capacity: 0,
          capabilities: worktreeRunner,
        })
      ).keep,
    ).toEqual([claimed.lease.workflowRunId]);
  });

  it("stops while a run stream is open", async () => {
    const { server, post, registerRepo, accept } = await setUp();
    await accept("runner-1");
    await registerRepo();
    await post("/api/runs", { repoId: 1, workflow: "build" });
    const stream = await fetch(`${server.url}/api/runs/1/stream`);

    await server.stop();

    expect(stream.status).toBe(200);
  });

  it("at start, gives each held run one more lease", async () => {
    const dbLocation = await createDataFolder();
    const { server, post, registerRepo, accept } = await setUp({ dbLocation });
    const first = await accept("runner-1");
    await registerRepo();
    await post("/api/runs", { repoId: 1, workflow: "build" });
    const { claimed } = await first.plane.sync({
      held: [],
      capacity: 1,
      capabilities: worktreeRunner,
    });
    await server.stop();
    const { db, close } = await openDb(dbLocation);
    await db.update(workflowRuns).set({ leaseUntil: sql`now()` });
    await close();

    const { plane } = await (await setUp({ dbLocation })).accept("runner-1");
    const { keep } = await plane.sync({
      held: claimed.map(({ lease }) => lease),
      capacity: 0,
      capabilities: worktreeRunner,
    });

    expect(keep).toEqual([1]);
  });

  it("at start, removes the sandbox of a run that finished more than 24 hours ago", async () => {
    const dbLocation = await createDataFolder();
    const { server, post, registerRepo, accept } = await setUp({ dbLocation });
    const first = await accept("runner-1");
    await registerRepo();
    await post("/api/runs", { repoId: 1, workflow: "build" });
    const [claimed] = (
      await first.plane.sync({ held: [], capacity: 1, capabilities: worktreeRunner })
    ).claimed;
    await first.plane.finishRun(claimed!.lease, "succeeded");
    await server.stop();
    const { db, close } = await openDb(dbLocation);
    await db.update(workflowRuns).set({
      finishedAt: sql`now() - interval '25 hours'`,
      sandboxKeptAt: sql`now() - interval '25 hours'`,
    });
    await close();

    const { plane } = await (await setUp({ dbLocation })).accept("runner-1");

    await expect
      .poll(
        async () =>
          (await plane.sync({ held: [], capacity: 0, capabilities: worktreeRunner })).sandboxes,
      )
      .toMatchObject([{ spec: "destroyed" }]);
  });

  it("at start, tries a schedule that was due during the downtime", async () => {
    const dbLocation = await createDataFolder();
    const seed = await openDb(dbLocation);
    const { id } = await createRepositories(seed.db).repo.createGitHub({
      name: "acme/app",
      githubRepoId: 100,
    });
    await inTransaction(seed.db, (repositories) =>
      repositories.workflowSchedule.rewrite(
        id,
        [{ path: "nightly.yml", schedule: "0 6 * * *", nextFireAt: new Date(0) }],
        [],
      ),
    );
    await seed.close();

    const { server } = await setUp({ dbLocation });
    await server.stop();

    const { db, close } = await openDb(dbLocation);
    const rows = await db.select().from(workflowSchedules);
    await close();
    expect(rows[0]!.lastFireAt).not.toBeNull();
  });

  it("answers that the runner is offline after its connection ends", async () => {
    const { registerRepo, accept } = await setUp();
    const { ended } = await accept("runner-1");

    ended();
    const response = await registerRepo();

    expect(response.status).toBe(503);
  });

  it("relays the bytes of a person to the runner and back", async () => {
    const { server, runnerStream } = await setUpRunningContainer();

    const { stream } = await connectStream(new URL(runSshPath(1), server.url), {});
    const atRunner = runnerStream.then(firstChunk);
    stream.write("from the person");

    expect(await atRunner).toBe("from the person");
    const atPerson = firstChunk(stream);
    (await runnerStream).write("from the runner");
    expect(await atPerson).toBe("from the runner");
  });

  it("ends the relay of a person when the runner loses its connection", async () => {
    const { server, connection, runnerStream } = await setUpRunningContainer();
    const { refusalReason } = await connectStream(new URL(runSshPath(1), server.url), {});
    await runnerStream;

    connection.close();

    expect(await refusalReason).toBe("The runner lost the connection");
  });

  it("ends the relay of a person when a new connection replaces the runner's", async () => {
    const { server, runnerStream, connectOverWebSocket } = await setUpRunningContainer();
    const { refusalReason } = await connectStream(new URL(runSshPath(1), server.url), {});
    await runnerStream;

    await connectOverWebSocket();

    expect(await refusalReason).toBe("The runner lost the connection");
  });

  it("refuses a relay to a person without a token on a server with a login", async () => {
    const { server } = await setUp({ auth: testAuthConfig("http://127.0.0.1") });

    const { refusalReason } = await connectStream(new URL(runSshPath(1), server.url), {});

    expect(await refusalReason).toBe("Log in first: halinka login");
  });

  it("refuses a relay socket with a path of no run", async () => {
    const { server } = await setUp();

    await expect(connectStream(new URL("/api/runs/one/ssh", server.url), {})).rejects.toThrow(
      "401",
    );
  });
});
