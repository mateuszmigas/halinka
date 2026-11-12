import { setTimeout as sleep } from "node:timers/promises";

import { type BirpcReturn, createBirpc } from "birpc";

import { type ControlPlane, maxMessageBytes } from "../controlPlane";
import { connectionClosed, invalidInput, isRefusal, type ProtocolError, refused } from "../errors";
import type { RunnerSigner } from "../keys";
import { exposed } from "../methods";
import { type RunnerCommands, runnerCommandMethods } from "../runnerCommands";
import { serverOriginOf } from "../serverUrl";
import type { ConnectOptions, RunnerConnection, RunnerHello, RunnerTransport } from "../transport";
import {
  codec,
  ignoreRejection,
  parseChallenge,
  parseRunnerAccept,
  signedHello,
  refusalOf,
  runnerConnectPath,
} from "./messages";
import { openRunnerRelay } from "./relayClient";

const reconnect = { initialMs: 500, maxMs: 10_000 };

const handshakeTimeoutMs = 10_000;

// A call without an answer closes the socket, so a half-open connection starts the reconnect.
const callTimeoutMs = 20_000;

const backoffMs = (failures: number) =>
  Math.min(reconnect.initialMs * 2 ** failures, reconnect.maxMs);

type WebSocketConnectionOptions = Pick<ConnectOptions, "onFailedAttempt"> & {
  hello: RunnerHello;
  signer: RunnerSigner;
};

// One birpc for every socket, so `plane` stays the same object across reconnects.
class WebSocketConnection implements RunnerConnection {
  readonly plane: BirpcReturn<ControlPlane, RunnerCommands>;
  serverId = "";
  private socket: WebSocket | undefined;
  private receive: (text: string) => void = () => {};
  private readonly stopping = new AbortController();
  private readonly ended = Promise.withResolvers<ProtocolError | undefined>();
  readonly closed = this.ended.promise;

  constructor(
    private readonly url: URL,
    commands: RunnerCommands,
    private readonly options: WebSocketConnectionOptions,
  ) {
    this.plane = createBirpc<ControlPlane, RunnerCommands>(
      exposed(commands, runnerCommandMethods),
      {
        ...codec,
        bind: "functions",
        timeout: callTimeoutMs,
        onTimeoutError: () => {
          if (this.socket) this.lose(this.socket);
          throw connectionClosed();
        },
        post: (text: string) => {
          if (this.socket?.readyState !== WebSocket.OPEN) throw connectionClosed();
          const bytes = Buffer.byteLength(text);
          if (bytes > maxMessageBytes) {
            throw invalidInput(`The message has ${bytes} bytes, more than ${maxMessageBytes}`);
          }
          this.socket.send(text);
        },
        on: (listener) => {
          this.receive = (text) => ignoreRejection(listener(text));
        },
      },
    );
  }

  async connect(signal?: AbortSignal) {
    const connecting = signal
      ? AbortSignal.any([signal, this.stopping.signal])
      : this.stopping.signal;
    try {
      await this.retry(connecting);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close() {
    this.end(undefined);
  }

  openRelay(relayId: string) {
    const { hello, signer } = this.options;
    return openRunnerRelay(this.url.href, { hello, signer, relayId });
  }

  // A reconnect starts at one failure, so it waits before its first attempt.
  private async retry(signal: AbortSignal, failures = 0) {
    for (; ; failures++) {
      if (failures > 0) await sleep(backoffMs(failures - 1), undefined, { signal });
      try {
        await this.open(signal);
        return;
      } catch (error) {
        if (isRefusal(error)) {
          this.end(error);
          throw error;
        }
        signal.throwIfAborted();
        this.options.onFailedAttempt?.(error as Error);
      }
    }
  }

  private open(signal: AbortSignal) {
    // `WebSocket` changes an `http:` URL to `ws:`.
    const socket = new WebSocket(this.url);
    const accepting = Promise.withResolvers<void>();
    // The close handshake can wait for a silent server: the attempt fails at once.
    const fail = () => {
      accepting.reject(new Error(`Cannot connect to ${socket.url}`));
      socket.close();
    };
    const stop = () => socket.close();
    signal.addEventListener("abort", fail, { once: true });
    const deadline = setTimeout(fail, handshakeTimeoutMs);
    let isChallenged = false;
    // One listener per socket, so a call right after the accept is not lost.
    socket.addEventListener("message", (event) => {
      const text = String(event.data);
      if (this.socket === socket) return this.receive(text);
      if (signal.aborted) return socket.close();
      if (!isChallenged) {
        const challenge = parseChallenge(text);
        if (challenge === undefined) return socket.close();
        isChallenged = true;
        return socket.send(
          signedHello(challenge, {
            hello: this.options.hello,
            signer: this.options.signer,
            serverUrl: serverOriginOf(this.url.href),
          }),
        );
      }
      const serverId = parseRunnerAccept(text);
      if (serverId === undefined) return socket.close();
      if (this.serverId && serverId !== this.serverId) {
        accepting.reject(refused("The server has another id now. Start the runner again."));
        return socket.close();
      }
      this.serverId = serverId;
      clearTimeout(deadline);
      signal.removeEventListener("abort", fail);
      this.stopping.signal.addEventListener("abort", stop, { once: true });
      this.socket = socket;
      accepting.resolve();
    });
    socket.addEventListener("close", ({ code, reason }) => {
      clearTimeout(deadline);
      signal.removeEventListener("abort", fail);
      this.stopping.signal.removeEventListener("abort", stop);
      const refusal = refusalOf(code, reason);
      accepting.reject(refusal ?? new Error(`Cannot connect to ${socket.url}`));
      if (this.socket !== socket) return;
      if (refusal) this.end(refusal);
      else this.lose(socket);
    });
    return accepting.promise;
  }

  // The socket is gone for the calls at once, also while its close handshake waits.
  private lose(socket: WebSocket) {
    if (this.socket !== socket) return;
    this.dropSocket();
    socket.close();
    if (!this.stopping.signal.aborted) this.retry(this.stopping.signal, 1).catch(() => {});
  }

  private end(refusal: ProtocolError | undefined) {
    this.stopping.abort();
    this.dropSocket();
    this.ended.resolve(refusal);
  }

  private dropSocket() {
    this.socket = undefined;
    void this.plane.$rejectPendingCalls(({ reject }) => reject(connectionClosed()));
  }
}

export class WebSocketClientTransport implements RunnerTransport {
  constructor(
    private readonly serverUrl: string,
    private readonly signer: RunnerSigner,
  ) {}

  async connect(hello: RunnerHello, commands: RunnerCommands, options: ConnectOptions = {}) {
    const connection = new WebSocketConnection(
      new URL(runnerConnectPath, this.serverUrl),
      commands,
      {
        hello,
        signer: this.signer,
        onFailedAttempt: options.onFailedAttempt,
      },
    );
    await connection.connect(options.signal);
    return connection;
  }
}
