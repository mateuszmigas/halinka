import { once } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";
import { type AddressInfo, connect as connect_ } from "node:net";
import type { Duplex } from "node:stream";

import { fakeTimers } from "@halinka/utils/testing";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocketServer, WebSocket as WsClient } from "ws";

import {
  type ControlPlane,
  maxMessageBytes,
  protocolVersion,
  type RunLease,
  type SyncRequest,
} from "../controlPlane";
import { leaseLost, refused } from "../errors";
import { createKeyPair, signerOf } from "../keys";
import type { RunnerCommands } from "../runnerCommands";
import { testSyncRequest } from "../testing";
import type { RelayHello, RunnerAcceptor, RunnerSession, StreamSocket } from "../transport";
import { connectStream, WebSocketClientTransport, WebSocketServerTransport } from "./index";
import {
  challengeOf,
  parseChallenge,
  runnerAcceptOf,
  runnerConnectPath,
  runnerRelayPath,
  signedHello,
  signedRelayHello,
} from "./messages";

const notCalled = async () => {
  throw new Error("Not called in this test");
};

const nothing = { keep: [], claimed: [], answers: [], messages: [], sandboxes: [] };

const signer = signerOf(createKeyPair());

const hello = { instanceId: "runner-1" };

const helloFor = (challenge: string, serverUrl = "http://127.0.0.1") =>
  signedHello(challenge, { hello, signer, serverUrl });

type NotListed = { notListed: () => Promise<void> };

class FakeCommands implements RunnerCommands {
  private readonly head = "abc";
  reads = 0;
  answering = Promise.resolve();

  async wake() {}

  async readRepo() {
    this.reads++;
    await this.answering;
    return {
      realPath: "/code/app",
      head: this.head,
      files: { ".halinka/config.yml": { source: "name: x", hash: "" } },
    };
  }

  async writeRepoFile() {
    return { hash: "" };
  }

  async readCommitFile() {
    return undefined;
  }

  async listFolders() {
    return { path: "/", isRepo: false, folders: [], isTruncated: false };
  }

  async listDevcontainers() {
    return [];
  }

  async setUpRepo() {
    return { files: [] };
  }

  async pushBranch() {}

  async openRelay() {}

  async openPullRequest() {
    return { url: "https://github.com/acme/app/pull/1", isCreated: true };
  }

  async notListed() {}
}

const commands = new FakeCommands();

class RecordingPlane implements ControlPlane {
  readonly syncs: SyncRequest[] = [];
  startStep = notCalled;
  finishStep = notCalled;
  startAttempt = notCalled;
  finishAttempt = notCalled;
  appendEvents = notCalled;
  openApproval = notCalled;
  askHuman = notCalled;
  askQuestion = notCalled;
  branchCreated = notCalled;
  readAgentCredentials = notCalled;
  readSetupSecrets = notCalled;
  readMirrorAccess = notCalled;
  readPushAccess = notCalled;
  storePushedBranch = notCalled;
  readCommentAccess = notCalled;
  storeComment = notCalled;
  readTestCredentials = notCalled;
  finishAgentTest = notCalled;
  reportSandbox = notCalled;
  answering = Promise.resolve();
  syncAnswer = nothing;

  async sync(request: SyncRequest) {
    this.syncs.push(request);
    await this.answering;
    return this.syncAnswer;
  }

  async finishRun({ workflowRunId }: RunLease): Promise<void> {
    throw leaseLost(workflowRunId);
  }

  async notListed() {}
}

const accepted = (sessions: RunnerSession[]) => {
  const [session] = sessions;
  if (!session) throw new Error("No runner was accepted");
  return session;
};

type ServerOptions = {
  port?: number;
  serverId?: string;
  accept?: (session: RunnerSession) => Promise<void>;
  publicUrl?: string;
  allowsConnection?: () => boolean;
  acceptRelay?: RunnerAcceptor["acceptRelay"];
  streamSocketOf?: (path: string) => ((socket: StreamSocket) => void) | undefined;
};

const portOf = (http: HttpServer) => (http.address() as AddressInfo).port;

describe("WebSocket transport", () => {
  const startServer = async (options: ServerOptions = {}) => {
    const {
      port = 0,
      serverId = "0123456789ab",
      accept = async () => {},
      acceptRelay = () => undefined,
      ...socketOptions
    } = options;
    const sessions: RunnerSession[] = [];
    const closed = vi.fn();
    const plane = new RecordingPlane();
    const http = createServer();
    const transport = new WebSocketServerTransport(
      http,
      {
        acceptRunner: async (session) => {
          await accept(session);
          sessions.push(session);
          return { plane, ended: closed, serverId };
        },
        acceptRelay,
      },
      socketOptions,
    );
    transport.listen();
    await once(http.listen(port), "listening");
    const stop = async () => {
      transport.close();
      if (http.listening) await http[Symbol.asyncDispose]();
    };
    onTestFinished(stop);
    return {
      url: `http://localhost:${portOf(http)}`,
      sessions,
      plane,
      syncs: plane.syncs,
      closed,
      stop,
    };
  };

  const openSocket = async (url: string) => {
    const socket = new WebSocket(new URL(runnerConnectPath, url));
    onTestFinished(() => socket.close());
    const [message] = await once(socket, "message");
    return { socket, challenge: parseChallenge(String((message as MessageEvent).data)) ?? "" };
  };

  // A WebSocket server that is not a runner transport.
  const startOtherServer = async (port: number, onConnection: (socket: WsClient) => void) => {
    const http = createServer();
    const sockets = new WebSocketServer({ server: http });
    sockets.on("connection", onConnection);
    await once(http.listen(port), "listening");
    onTestFinished(() => {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      return http[Symbol.asyncDispose]();
    });
    return `http://localhost:${portOf(http)}`;
  };

  const closeEventOf = async (socket: WebSocket) => (await once(socket, "close"))[0] as CloseEvent;

  const closeAtHello = (code: number) => (socket: WsClient) => {
    socket.send(challengeOf("challenge"));
    socket.once("message", () => socket.close(code, "Closed at the hello"));
  };

  const connect = async (url: string, runner: RunnerCommands = commands) => {
    const connection = await new WebSocketClientTransport(url, signer).connect(hello, runner);
    onTestFinished(() => connection.close());
    return connection;
  };

  const firstFailure = async (url: string) => {
    const stopping = new AbortController();
    const failed = Promise.withResolvers<Error>();
    const connecting = new WebSocketClientTransport(url, signer)
      .connect(hello, commands, { signal: stopping.signal, onFailedAttempt: failed.resolve })
      .catch(() => {});
    const error = await failed.promise;
    stopping.abort();
    await connecting;
    return error;
  };

  it("gives the runner's control plane calls to the server", async () => {
    const { url, syncs } = await startServer();
    const connection = await connect(url);

    expect(await connection.plane.sync(testSyncRequest)).toEqual(nothing);

    expect(syncs).toEqual([testSyncRequest]);
  });

  it("gives the server the runner's hello and key", async () => {
    const { url, sessions } = await startServer();

    await connect(url);

    expect(accepted(sessions)).toMatchObject({
      instanceId: "runner-1",
      publicKey: signer.publicKey,
    });
  });

  it("refuses a call to a method that is not in the control plane", async () => {
    const connection = await connect((await startServer()).url);

    await expect((connection.plane as unknown as NotListed).notListed()).rejects.toThrow(
      "not found",
    );
  });

  const lease = { workflowRunId: 1, lease: "lease-1" };

  const sendOverLimit = async () => {
    const { url, syncs } = await startServer();
    const connection = await connect(url);
    const text = "x".repeat(maxMessageBytes);
    const output = {
      kind: "output",
      payload: { stepId: "s", attemptId: 1, stream: "stdout", text },
    };
    const sending = connection.plane.appendEvents(lease, {
      batchId: "b1",
      events: [output as never],
    });
    return { connection, syncs, sending };
  };

  it("refuses to send a message over the limit", async () => {
    const { sending } = await sendOverLimit();

    await expect(sending).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("keeps the connection after it refuses to send a message over the limit", async () => {
    const { connection, syncs, sending } = await sendOverLimit();
    await sending.catch(() => {});

    expect(await connection.plane.sync(testSyncRequest)).toEqual(nothing);
    expect(syncs).toHaveLength(1);
  });

  const answerOverLimit = async () => {
    const { url, plane } = await startServer();
    const connection = await connect(url);
    const message = { workflowRunId: 1, text: "x".repeat(maxMessageBytes) };
    plane.syncAnswer = { ...nothing, messages: [message as never] };
    return { connection, plane, answer: connection.plane.sync(testSyncRequest) };
  };

  it("fails a call whose answer is over the limit", async () => {
    const { answer } = await answerOverLimit();

    await expect(answer).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("keeps the connection after an answer over the limit", async () => {
    const { connection, plane, answer } = await answerOverLimit();
    await answer.catch(() => {});
    plane.syncAnswer = nothing;

    expect(await connection.plane.sync(testSyncRequest)).toEqual(nothing);
  });

  it("refuses a call to a method that is not a runner command", async () => {
    const { url, sessions } = await startServer();
    await connect(url);
    const { commands } = accepted(sessions);

    await expect((commands as unknown as NotListed).notListed()).rejects.toThrow("not found");
  });

  it.each(["{}", "not json", '{"protocolVersion":"19"}'])(
    "closes a socket whose first message is %s",
    async (first) => {
      const { socket } = await openSocket((await startServer()).url);

      socket.send(first);

      expect((await closeEventOf(socket)).code).toBe(1008);
    },
  );

  it("refuses a runner of another protocol version", async () => {
    const { socket, challenge } = await openSocket((await startServer()).url);

    socket.send(
      JSON.stringify({
        ...JSON.parse(helloFor(challenge)),
        protocolVersion: protocolVersion + 1,
      }),
    );

    expect(await closeEventOf(socket)).toMatchObject({
      code: 4001,
      reason: `The server uses protocol version ${protocolVersion}, not ${protocolVersion + 1}`,
    });
  });

  it("refuses a hello of another protocol version and another shape as an update", async () => {
    const { socket } = await openSocket((await startServer()).url);

    socket.send(JSON.stringify({ protocolVersion: protocolVersion + 1, runner: { id: 1 } }));

    expect((await closeEventOf(socket)).code).toBe(4001);
  });

  it("fails to connect with update needed when the server uses another protocol version", async () => {
    const url = await startOtherServer(0, closeAtHello(4001));

    await expect(connect(url)).rejects.toMatchObject({ code: "update_needed" });
  });

  it("closes a socket that sends no hello in 10 s with a code to connect again", async () => {
    const { url } = await startServer();
    fakeTimers(["setTimeout", "clearTimeout"]);
    const { socket } = await openSocket(url);
    const closing = closeEventOf(socket);

    await vi.advanceTimersByTimeAsync(10_000);

    expect((await closing).code).toBe(1013);
  });

  it("refuses a hello that names another server", async () => {
    const { url } = await startServer({ publicUrl: "https://halinka.example.com" });
    const { socket, challenge } = await openSocket(url);

    socket.send(helloFor(challenge, "https://other.example.com"));

    expect(await closeEventOf(socket)).toMatchObject({
      code: 1008,
      reason:
        "The runner connected to https://other.example.com, not to https://halinka.example.com",
    });
  });

  it("accepts a hello that names the public URL", async () => {
    const { url, sessions } = await startServer({ publicUrl: "https://halinka.example.com" });
    const { socket, challenge } = await openSocket(url);

    socket.send(helloFor(challenge, "https://halinka.example.com"));

    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    socket.close();
  });

  it("closes a socket whose first message is too large", async () => {
    const { socket, challenge } = await openSocket((await startServer()).url);

    socket.send(JSON.stringify({ ...JSON.parse(helloFor(challenge)), pad: "x".repeat(5000) }));

    expect((await closeEventOf(socket)).code).toBe(1008);
  });

  it("refuses a socket over the limit of connections", async () => {
    const { url } = await startServer({ allowsConnection: () => false });

    const socket = new WebSocket(`${url}${runnerConnectPath}`);

    await once(socket, "close");
    expect(socket.readyState).toBe(socket.CLOSED);
  });

  it("refuses a hello that is signed for another challenge", async () => {
    const { socket } = await openSocket((await startServer()).url);

    socket.send(helloFor("another-challenge"));

    expect(await closeEventOf(socket)).toMatchObject({
      code: 1008,
      reason: "The signature of the hello is not valid",
    });
  });

  it("fails to connect when the server refuses the runner", async () => {
    const { url } = await startServer({
      accept: async () => {
        throw refused("Unknown runner");
      },
    });

    await expect(connect(url)).rejects.toMatchObject({
      code: "refused",
      message: "Unknown runner",
    });
  });

  it("tells the server when the runner leaves before the server accepts it", async () => {
    const accepting = Promise.withResolvers<void>();
    const { url, closed } = await startServer({ accept: () => accepting.promise });
    const { socket, challenge } = await openSocket(url);
    socket.send(helloFor(challenge));
    socket.close();
    await closeEventOf(socket);

    accepting.resolve();

    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
  });

  it("answers a call that the server makes at once after the accept", async () => {
    const reads: Promise<unknown>[] = [];
    const { url } = await startServer({
      accept: async ({ commands }) => {
        setImmediate(() => reads.push(commands.readRepo({ repoPath: "/code/app" })));
      },
    });

    await connect(url);

    await vi.waitFor(() => expect(reads).toHaveLength(1));
    await expect(reads[0]).resolves.toMatchObject({ head: "abc" });
  });

  it("gives the runner the reason when the server closes the connection", async () => {
    const { url, sessions } = await startServer();
    const connection = await connect(url);

    accepted(sessions).close("Revoked");

    expect(await connection.closed).toMatchObject({ code: "refused", message: "Revoked" });
  });

  it("ends the connection with update needed when a reconnect finds another protocol", async () => {
    const first = await startServer();
    const connection = await connect(first.url);
    await first.stop();

    await startOtherServer(Number(new URL(first.url).port), closeAtHello(4001));

    expect(await connection.closed).toMatchObject({ code: "update_needed" });
  });

  it("fails to connect as refused after another close code from 4000 to 4999", async () => {
    const url = await startOtherServer(0, closeAtHello(4002));

    await expect(connect(url)).rejects.toMatchObject({ code: "refused" });
  });

  it("gives the runner no reason when the runner closes the connection", async () => {
    const connection = await connect((await startServer()).url);

    connection.close();

    expect(await connection.closed).toBeUndefined();
  });

  it("does not connect again when the server refuses the runner after a drop", async () => {
    const first = await startServer();
    const connection = await connect(first.url);
    await first.stop();
    const accept = vi.fn(async () => {
      throw refused("Revoked");
    });

    await startServer({ port: Number(new URL(first.url).port), accept });

    expect(await connection.closed).toMatchObject({ code: "refused", message: "Revoked" });
    expect(accept).toHaveBeenCalledOnce();
  });

  it("connects again when the server fails to accept the runner", async () => {
    const first = await startServer();
    const connection = await connect(first.url);
    await first.stop();
    const accept = vi.fn(async () => {}).mockRejectedValueOnce(new Error("No database"));

    await startServer({ port: Number(new URL(first.url).port), accept });

    await vi.waitFor(
      async () => expect(await connection.plane.sync(testSyncRequest)).toEqual(nothing),
      { timeout: 3000 },
    );
  });

  it("fails a runner command that the server calls before it accepts the runner", async () => {
    const errors: unknown[] = [];
    const { url } = await startServer({
      accept: async ({ commands }) => {
        await commands.readRepo({ repoPath: "/code/app" }).catch((error) => errors.push(error));
      },
    });

    await connect(url);

    expect(errors).toMatchObject([{ code: "connection_closed" }]);
  });

  it("fails the attempt when the server accepts before it sends a challenge", async () => {
    const url = await startOtherServer(0, (socket) => socket.send(runnerAcceptOf("0123456789ab")));

    expect((await firstFailure(url)).message).toContain("Cannot connect");
  });

  it("gives the runner the id of the server", async () => {
    const { url } = await startServer({ serverId: "ba9876543210" });

    const connection = await connect(url);

    expect(connection.serverId).toBe("ba9876543210");
  });

  it.each(["../../etc/xx", "abc123"])("fails the attempt when the server id is %s", async (id) => {
    const url = await startOtherServer(0, (socket) => {
      socket.send(challengeOf("challenge"));
      socket.once("message", () => socket.send(runnerAcceptOf(id)));
    });

    expect((await firstFailure(url)).message).toContain("Cannot connect");
  });

  it("ends the connection when a reconnect finds another server id", async () => {
    const first = await startServer();
    const connection = await connect(first.url);
    await first.stop();

    await startServer({ port: Number(new URL(first.url).port), serverId: "ba9876543210" });

    expect(await connection.closed).toMatchObject({
      code: "refused",
      message: expect.stringContaining("another id"),
    });
  });

  it("fails the attempt when the server answers the hello with another message", async () => {
    const url = await startOtherServer(0, (socket) => {
      socket.send(challengeOf("challenge"));
      socket.once("message", () => socket.send("{}"));
    });

    expect((await firstFailure(url)).message).toContain("Cannot connect");
  });

  it("fails the attempt when the server sends no challenge in 10 s", async () => {
    const url = await startOtherServer(0, () => {});
    fakeTimers(["setTimeout", "clearTimeout"]);

    const failure = firstFailure(url);
    await vi.advanceTimersByTimeAsync(10_000);

    expect((await failure).message).toContain("Cannot connect");
  });

  it("connects when the server starts after the runner", async () => {
    const first = await startServer();
    await first.stop();
    const failed = vi.fn();
    const connecting = new WebSocketClientTransport(first.url, signer).connect(hello, commands, {
      onFailedAttempt: failed,
    });
    await vi.waitFor(() => expect(failed).toHaveBeenCalled());

    await startServer({ port: Number(new URL(first.url).port) });
    const connection = await connecting;
    onTestFinished(() => connection.close());

    expect(await connection.plane.sync(testSyncRequest)).toEqual(nothing);
  });

  it("stops connecting when the signal aborts", async () => {
    const first = await startServer();
    await first.stop();
    const stopping = new AbortController();
    const failed = Promise.withResolvers<void>();
    const connecting = new WebSocketClientTransport(first.url, signer).connect(hello, commands, {
      signal: stopping.signal,
      onFailedAttempt: () => failed.resolve(),
    });
    await failed.promise;

    stopping.abort();

    await expect(connecting).rejects.toMatchObject({ name: "AbortError" });
  });

  // birpc keeps the real `setTimeout`, so the test waits for the deadline.
  it("closes the socket when a call gets no answer in 20 s", { timeout: 30_000 }, async () => {
    const { url, plane, closed } = await startServer();
    const connection = await connect(url);
    plane.answering = new Promise(() => {});

    const call = await connection.plane.sync(testSyncRequest).catch((error: unknown) => error);

    expect(call).toMatchObject({ code: "connection_closed" });
    await vi.waitFor(() => expect(closed).toHaveBeenCalled());
  });

  it("terminates a socket that does not answer a ping", async () => {
    fakeTimers(["setInterval", "clearInterval"]);
    const { url } = await startServer();
    const socket = new WsClient(new URL(runnerConnectPath, url), { autoPong: false });
    onTestFinished(() => socket.terminate());
    await once(socket, "open");
    const closing = once(socket, "close");

    await vi.advanceTimersByTimeAsync(20_000);

    expect((await closing)[0]).toBe(1006);
  });

  it("closes a socket that waits for the accept when the runner closes the connection", async () => {
    const first = await startServer();
    const connection = await connect(first.url);
    await first.stop();
    const waiting = Promise.withResolvers<WsClient>();
    await startOtherServer(Number(new URL(first.url).port), waiting.resolve);
    const socket = await waiting.promise;

    connection.close();

    await once(socket, "close");
    expect(socket.readyState).toBe(socket.CLOSED);
  });

  it("shortens a refusal reason to the length of a close reason", async () => {
    const { url } = await startServer({
      accept: async () => {
        throw refused("x".repeat(200));
      },
    });

    await expect(connect(url)).rejects.toMatchObject({ message: "x".repeat(123) });
  });

  it("drops the server's answer to a call when the runner left during the call", async () => {
    const { url, plane, closed } = await startServer();
    const connection = await connect(url);
    const answering = Promise.withResolvers<void>();
    plane.answering = answering.promise;
    const call = connection.plane.sync(testSyncRequest).catch((error: unknown) => error);
    await vi.waitFor(() => expect(plane.syncs).toHaveLength(1));
    connection.close();
    await vi.waitFor(() => expect(closed).toHaveBeenCalled());

    answering.resolve();
    await new Promise(setImmediate);

    expect(await call).toMatchObject({ code: "connection_closed" });
  });

  it("drops the runner's answer to a call when the server left during the call", async () => {
    const runner = new FakeCommands();
    const answering = Promise.withResolvers<void>();
    runner.answering = answering.promise;
    const { url, sessions } = await startServer();
    const connection = await connect(url, runner);
    const read = accepted(sessions)
      .commands.readRepo({ repoPath: "/code/app" })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(runner.reads).toBe(1));
    accepted(sessions).close("Revoked");
    await connection.closed;

    answering.resolve();
    await new Promise(setImmediate);

    expect(await read).toMatchObject({ code: "connection_closed" });
  });

  it("keeps the code and the message of an error", async () => {
    const connection = await connect((await startServer()).url);

    await expect(
      connection.plane.finishRun({ workflowRunId: 7, lease: "lease-7" }, "failed"),
    ).rejects.toMatchObject({ code: "lease_lost", message: "The lease of run 7 is not held" });
  });

  it("calls the runner's commands from the server", async () => {
    const { url, sessions } = await startServer();
    await connect(url);
    const { commands } = accepted(sessions);

    const read = await commands.readRepo({ repoPath: "/code/app" });

    expect(read).toEqual({
      realPath: "/code/app",
      head: "abc",
      files: { ".halinka/config.yml": { source: "name: x", hash: "" } },
    });
  });

  it("tells the server when the runner disconnects", async () => {
    const { url, closed } = await startServer();
    const connection = await connect(url);

    connection.close();

    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
  });

  it("fails the server's calls to the runner after the runner disconnects", async () => {
    const { url, sessions, closed } = await startServer();
    const connection = await connect(url);
    connection.close();
    await vi.waitFor(() => expect(closed).toHaveBeenCalled());

    await expect(sessions[0]?.commands.wake()).rejects.toMatchObject({
      code: "connection_closed",
    });
  });

  it("fails the control plane calls after the runner closes the connection", async () => {
    const connection = await connect((await startServer()).url);

    connection.close();

    await expect(connection.plane.sync(testSyncRequest)).rejects.toMatchObject({
      code: "connection_closed",
    });
  });

  it("fails the control plane calls while the server is away", async () => {
    const server = await startServer();
    const connection = await connect(server.url);

    await server.stop();

    await expect(connection.plane.sync(testSyncRequest)).rejects.toMatchObject({
      code: "connection_closed",
    });
  });

  // The client waits 500 ms before it connects again.
  it("connects again when the server comes back", async () => {
    const first = await startServer();
    const connection = await connect(first.url);
    await first.stop();

    await startServer({ port: Number(new URL(first.url).port) });

    await vi.waitFor(
      async () => expect(await connection.plane.sync(testSyncRequest)).toEqual(nothing),
      { timeout: 3000 },
    );
  });

  it("refuses a connection from a web page", async () => {
    const { url } = await startServer();
    const socket = new WsClient(new URL(runnerConnectPath, url), {
      origin: "https://example.com",
    });

    const [error] = await once(socket, "error");

    expect((error as Error).message).toContain("401");
  });

  it("keeps listening after a request target that is no URL", async () => {
    const { url } = await startServer();
    const { hostname, port } = new URL(url);
    const socket = connect_({ host: hostname, port: Number(port) });
    socket.write(
      `GET //[ HTTP/1.1\r\nHost: ${hostname}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
    );

    const [answer] = (await once(socket, "data")) as [Buffer];
    socket.destroy();

    expect(String(answer)).toContain("401");
  });

  it("refuses a connection on another path", async () => {
    const { url } = await startServer();
    const socket = new WebSocket(new URL("/api/other", url));

    const [event] = await Promise.race([once(socket, "error"), once(socket, "open")]);

    expect((event as Event).type).toBe("error");
  });

  it("fails the attempt when the server does not accept runners", async () => {
    const http = createServer((_, response) => response.writeHead(404).end());
    await once(http.listen(0), "listening");
    onTestFinished(() => http[Symbol.asyncDispose]());

    const error = await firstFailure(`http://localhost:${portOf(http)}`);

    expect(error.message).toContain("Cannot connect");
  });

  const firstChunk = async (stream: Duplex) => String((await once(stream, "data"))[0]);

  const startWithRelay = async () => {
    const streams = Promise.withResolvers<Duplex>();
    const hellos: RelayHello[] = [];
    const server = await startServer({
      acceptRelay: (hello) => {
        hellos.push(hello);
        return hello.relayId === "known" ? streams.resolve : undefined;
      },
    });
    const connection = await connect(server.url);
    return { connection, hellos, serverStream: streams.promise };
  };

  it("carries bytes in both directions", async () => {
    const { connection, serverStream } = await startWithRelay();

    const runnerSide = await connection.openRelay("known");
    const serverSide = await serverStream;
    const atServer = firstChunk(serverSide);
    runnerSide.write("from the runner");
    const atRunner = firstChunk(runnerSide);
    serverSide.write("from the server");

    expect(await atServer).toBe("from the runner");
    expect(await atRunner).toBe("from the server");
  });

  it("closes the stream of the server when the runner closes its stream", async () => {
    const { connection, serverStream } = await startWithRelay();
    const runnerSide = await connection.openRelay("known");
    const serverSide = await serverStream;
    const closed = once(serverSide, "close");

    runnerSide.destroy();

    await closed;
  });

  it("gives the server the signed key and the process of the runner", async () => {
    const { connection, hellos } = await startWithRelay();

    await connection.openRelay("known");

    expect(hellos).toEqual([
      { relayId: "known", instanceId: hello.instanceId, publicKey: signer.publicKey },
    ]);
  });

  it("refuses a relay that the server does not wait for", async () => {
    const { connection } = await startWithRelay();

    await expect(connection.openRelay("unknown")).rejects.toMatchObject({
      code: "refused",
      message: "The server does not wait for this relay",
    });
  });

  it("does not take the signature of a runner hello for a relay", async () => {
    const { url } = await startServer({ acceptRelay: () => () => {} });
    const socket = new WebSocket(new URL(runnerRelayPath, url));
    onTestFinished(() => socket.close());
    const [message] = await once(socket, "message");
    const challenge = parseChallenge(String((message as MessageEvent).data)) ?? "";

    socket.send(JSON.stringify({ ...JSON.parse(helloFor(challenge, url)), relayId: "known" }));

    expect((await closeEventOf(socket)).reason).toBe("The signature of the hello is not valid");
  });

  it("refuses a relay hello of another protocol version as an update", async () => {
    const { url } = await startServer({ acceptRelay: () => () => {} });
    const socket = new WebSocket(new URL(runnerRelayPath, url));
    onTestFinished(() => socket.close());
    await once(socket, "message");

    socket.send(JSON.stringify({ protocolVersion: protocolVersion + 1, relayId: "known" }));

    expect((await closeEventOf(socket)).code).toBe(4001);
  });

  it("does not take the signature of a relay hello for a runner", async () => {
    const { url } = await startServer();
    const { socket, challenge } = await openSocket(url);

    socket.send(
      signedRelayHello(challenge, {
        hello,
        signer,
        serverUrl: "http://127.0.0.1",
        relayId: "known",
      }),
    );

    expect((await closeEventOf(socket)).reason).toBe("The signature of the hello is not valid");
  });

  const streamPath = "/api/stream";

  const startWithStream = async (onSocket: (socket: StreamSocket) => void = () => {}) => {
    const sockets: StreamSocket[] = [];
    const { url } = await startServer({
      streamSocketOf: (path) =>
        path === streamPath
          ? (socket) => {
              sockets.push(socket);
              onSocket(socket);
            }
          : undefined,
    });
    return { url: new URL(streamPath, url), sockets };
  };

  it("gives the headers of a stream socket to the server", async () => {
    const { url, sockets } = await startWithStream();

    const { stream } = await connectStream(url, { authorization: "Bearer secret" });
    onTestFinished(() => void stream.destroy());
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    expect(sockets[0]?.headers.authorization).toBe("Bearer secret");
  });

  it("gives the client the reason of a refusal", async () => {
    const { url } = await startWithStream(({ close }) => close("Log in first"));

    const { refusalReason } = await connectStream(url, {});

    expect(await refusalReason).toBe("Log in first");
  });

  it("gives the client no refusal at a normal close", async () => {
    const { url, sockets } = await startWithStream();
    const { refusalReason, stream } = await connectStream(url, {});
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    stream.destroy();

    expect(await refusalReason).toBeUndefined();
  });

  it("closes the stream of the server when the client leaves", async () => {
    const { url, sockets } = await startWithStream();
    const { stream } = await connectStream(url, {});
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const closed = once(sockets[0]!.stream, "close");

    stream.destroy();

    await closed;
  });

  it("refuses a stream socket from a web page", async () => {
    const { url } = await startWithStream();
    const socket = new WsClient(url, { origin: "https://example.com" });

    const [error] = await once(socket, "error");

    expect((error as Error).message).toContain("401");
  });

  it("refuses a socket to another path", async () => {
    const { url } = await startWithStream();
    const socket = new WsClient(new URL("/api/other", url));

    const [error] = await once(socket, "error");

    expect((error as Error).message).toContain("401");
  });
});
