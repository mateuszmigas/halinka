import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";

import { createBirpc } from "birpc";
import { type RawData, type WebSocket, WebSocketServer } from "ws";

import { controlPlaneMethods } from "../checkedPlane";
import {
  type ControlPlane,
  maxMessageBytes,
  protocolVersion,
  unsupportedVersionReason,
} from "../controlPlane";
import { connectionClosed, invalidInput, isRefusal, ProtocolError } from "../errors";
import { wrapMethods } from "../methods";
import { commandTimeoutMs, type RunnerCommands } from "../runnerCommands";
import { wrongServerReason } from "../serverUrl";
import type { RunnerAcceptor, RunnerSession, StreamSocket } from "../transport";
import {
  closeCodeOf,
  relayAcceptMessage,
  runnerAcceptOf,
  challengeOf,
  codec,
  ignoreRejection,
  isSigned,
  isSignedRelay,
  parseHello,
  parseHelloVersion,
  parseRelayHello,
  refusedCode,
  runnerConnectPath,
  updateNeededCode,
  runnerRelayPath,
  type SignedHello,
} from "./messages";
import { socketStream } from "./socketStream";

// `undefined` for a target that is no URL, which a client can send before any check.
const pathOf = (request: IncomingMessage) =>
  URL.parse(request.url ?? "/", "http://server")?.pathname;

// `ws` gives a text message as a Buffer.
const textOf = (data: RawData) => (data as Buffer).toString("utf8");

const helloTimeoutMs = 10_000;

// A socket without a pong to the last ping is dead: it never closes by itself.
const pingMs = 10_000;
const internalErrorCode = 1011;
// A slow runner connects again after it: the WebSocket code "Try Again Later".
const tryAgainCode = 1013;

// The birpc fields around a result: `{"t":"s","i":"<id>","r":...}`
const answerEnvelopeBytes = 256;

const sendHelloFirst = "Send a hello first";

// `ws` throws on a close reason of more than 123 bytes.
const closeRefused = (socket: WebSocket, reason: string, code = refusedCode) => {
  let text = reason;
  while (Buffer.byteLength(text) > 123) text = text.slice(0, -1);
  socket.close(code, text);
};

const closeOnAcceptError = (socket: WebSocket, error: unknown) => {
  if (isRefusal(error)) closeRefused(socket, error.message, closeCodeOf(error));
  else socket.close(internalErrorCode, "The server could not accept the runner");
};

type Hello = Pick<RunnerSession, "instanceId" | "publicKey">;

// birpc sends no answer when `post` throws, so an answer over the limit fails its call here.
const withAnswerLimit = (plane: ControlPlane) =>
  wrapMethods(plane, controlPlaneMethods, (method, name) => async (...args) => {
    const result = await method(...args);
    const bytes = Buffer.byteLength(JSON.stringify(result) ?? "");
    if (bytes > maxMessageBytes - answerEnvelopeBytes) {
      throw invalidInput(`The answer to ${name} has ${bytes} bytes, more than ${maxMessageBytes}`);
    }
    return result;
  });

const serveRunner = async (socket: WebSocket, hello: Hello, server: RunnerAcceptor) => {
  // `acceptRunner` needs the commands before it gives the plane.
  const functions: ControlPlane = Object.create(null);
  // The runner takes calls only after the accept.
  let isAccepted = false;
  const runner = createBirpc<RunnerCommands, ControlPlane>(functions, {
    ...codec,
    bind: "functions",
    timeout: commandTimeoutMs,
    onTimeoutError: () => {
      throw new ProtocolError(
        "timeout",
        `The runner did not answer in ${commandTimeoutMs / 1000} s`,
      );
    },
    post: (text: string) => {
      if (!isAccepted || socket.readyState !== socket.OPEN) throw connectionClosed();
      socket.send(text);
    },
    on: (listener) => socket.on("message", (data) => ignoreRejection(listener(textOf(data)))),
  });
  let ended = () => {};
  socket.on("close", () => {
    void runner.$rejectPendingCalls(({ reject }) => reject(connectionClosed()));
    ended();
  });
  const session = await server
    .acceptRunner({
      ...hello,
      commands: runner,
      close: (reason) => closeRefused(socket, reason),
    })
    .catch((error: unknown) => {
      closeOnAcceptError(socket, error);
      return undefined;
    });
  if (!session) return;
  if (socket.readyState !== socket.OPEN) {
    session.ended();
    return;
  }
  Object.assign(functions, withAnswerLimit(session.plane));
  ended = session.ended;
  socket.send(runnerAcceptOf(session.serverId));
  isAccepted = true;
};

const maxHelloBytes = 4096;

type WebSocketServerTransportOptions = {
  // a hello must name it
  publicUrl?: string;
  // a limit before any work for a socket
  allowsConnection?: (request: IncomingMessage) => boolean;
  // the handler of a path that is not of a runner
  streamSocketOf?: (path: string) => ((socket: StreamSocket) => void) | undefined;
};

type ReadHelloOptions<H extends SignedHello> = {
  parse: (text: string) => H | undefined;
  isValid: (challenge: string, hello: H) => boolean;
};

export class WebSocketServerTransport {
  private sockets: WebSocketServer | undefined;
  private pinger: NodeJS.Timeout | undefined;

  constructor(
    private readonly http: HttpServer,
    private readonly server: RunnerAcceptor,
    private readonly options: WebSocketServerTransportOptions = {},
  ) {}

  private readHello<H extends SignedHello>(
    socket: WebSocket,
    { parse, isValid }: ReadHelloOptions<H>,
    onHello: (hello: H) => void,
  ) {
    const challenge = randomBytes(32).toString("base64url");
    socket.send(challengeOf(challenge));
    const deadline = setTimeout(() => socket.close(tryAgainCode, sendHelloFirst), helloTimeoutMs);
    socket.once("close", () => clearTimeout(deadline));
    socket.once("message", (data) => {
      clearTimeout(deadline);
      const received = textOf(data);
      const text = Buffer.byteLength(received) <= maxHelloBytes ? received : "";
      const version = parseHelloVersion(text);
      if (version !== undefined && version !== protocolVersion) {
        return closeRefused(socket, unsupportedVersionReason(version), updateNeededCode);
      }
      const hello = parse(text);
      const { publicUrl } = this.options;
      const wrongServer = hello && publicUrl && wrongServerReason(hello.serverUrl, publicUrl);
      if (!hello) closeRefused(socket, sendHelloFirst);
      else if (!isValid(challenge, hello)) {
        closeRefused(socket, "The signature of the hello is not valid");
      } else if (wrongServer) {
        closeRefused(socket, wrongServer);
      } else {
        onHello(hello);
      }
    });
  }

  private serveRelay(socket: WebSocket) {
    this.readHello(
      socket,
      { parse: parseRelayHello, isValid: isSignedRelay },
      ({ relayId, instanceId, publicKey }) => {
        const attach = this.server.acceptRelay({ relayId, instanceId, publicKey });
        if (!attach) return closeRefused(socket, "The server does not wait for this relay");
        socket.send(relayAcceptMessage);
        attach(socketStream(socket));
      },
    );
  }

  private serveRunner(socket: WebSocket) {
    this.readHello(
      socket,
      { parse: parseHello, isValid: isSigned },
      ({ instanceId, publicKey }) => {
        void serveRunner(socket, { instanceId, publicKey }, this.server);
      },
    );
  }

  private handlerOf(request: IncomingMessage) {
    const path = pathOf(request);
    if (path === undefined) return undefined;
    if (path === runnerConnectPath) return (socket: WebSocket) => this.serveRunner(socket);
    if (path === runnerRelayPath) return (socket: WebSocket) => this.serveRelay(socket);
    const accept = this.options.streamSocketOf?.(path);
    return (
      accept &&
      ((socket: WebSocket) =>
        accept({
          headers: request.headers,
          stream: socketStream(socket),
          close: (reason) => closeRefused(socket, reason),
        }))
    );
  }

  listen() {
    const sockets = new WebSocketServer({
      server: this.http,
      maxPayload: maxMessageBytes,
      // A browser sends an `Origin`, and a runner does not: no web page can connect as a runner.
      verifyClient: ({ origin, req }: { origin?: string; req: IncomingMessage }) =>
        !origin &&
        this.handlerOf(req) !== undefined &&
        (this.options.allowsConnection?.(req) ?? true),
    });
    const alive = new WeakSet<WebSocket>();
    sockets.on("connection", (socket, request) => {
      alive.add(socket);
      socket.on("pong", () => alive.add(socket));
      this.handlerOf(request)?.(socket);
    });
    // `ws` repeats the HTTP server's errors; the server's owner handles them.
    sockets.on("error", () => {});
    this.pinger = setInterval(() => {
      for (const socket of sockets.clients) {
        if (alive.delete(socket)) socket.ping();
        else socket.terminate();
      }
    }, pingMs);
    this.sockets = sockets;
  }

  // `ws` does not end open sockets when it closes.
  close() {
    clearInterval(this.pinger);
    for (const socket of this.sockets?.clients ?? []) socket.terminate();
    this.sockets?.close();
    this.sockets = undefined;
  }
}
