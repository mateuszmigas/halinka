import type { Duplex } from "node:stream";

import { WebSocket } from "ws";

import type { RunnerSigner } from "../keys";
import { serverOriginOf } from "../serverUrl";
import type { RunnerHello } from "../transport";
import {
  relayAcceptMessage,
  handshakeTimeoutMs,
  parseChallenge,
  refusalOf,
  refusedCode,
  runnerRelayPath,
  signedRelayHello,
} from "./messages";
import { socketStream } from "./socketStream";

// `ws`, not the global `WebSocket`: it has backpressure and sends headers.
type RunnerRelayOptions = { hello: RunnerHello; signer: RunnerSigner; relayId: string };

export const openRunnerRelay = (connectUrl: string, options: RunnerRelayOptions) =>
  new Promise<Duplex>((resolve, reject) => {
    const socket = new WebSocket(new URL(runnerRelayPath, connectUrl), {
      handshakeTimeout: handshakeTimeoutMs,
    });
    socket.once("message", (challengeData: Buffer) => {
      const challenge = parseChallenge(challengeData.toString("utf8"));
      if (challenge === undefined) return socket.close();
      socket.once("message", (answer: Buffer) => {
        if (answer.toString("utf8") !== relayAcceptMessage) return socket.close();
        resolve(socketStream(socket));
      });
      socket.send(
        signedRelayHello(challenge, { ...options, serverUrl: serverOriginOf(connectUrl) }),
      );
    });
    socket.once("error", reject);
    socket.once("close", (code, reason) =>
      reject(
        refusalOf(code, reason.toString("utf8")) ??
          new Error(`The relay socket closed with code ${code}`),
      ),
    );
  });

// `refusalReason`: the reason of the server, undefined for a close without one.
export const connectStream = (url: URL, headers: Record<string, string>) =>
  new Promise<{ stream: Duplex; refusalReason: Promise<string | undefined> }>((resolve, reject) => {
    const socket = new WebSocket(url, { handshakeTimeout: handshakeTimeoutMs, headers });
    const refusalReason = new Promise<string | undefined>((resolveRefusalReason) => {
      socket.once("close", (code, reason) =>
        resolveRefusalReason(code === refusedCode ? reason.toString("utf8") : undefined),
      );
    });
    socket.once("error", reject);
    socket.once("open", () => {
      socket.off("error", reject);
      resolve({ stream: socketStream(socket), refusalReason });
    });
  });
