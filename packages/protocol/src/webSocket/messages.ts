import { z } from "zod";

import { protocolVersion } from "../controlPlane";
import { codeOf, hasCode, refused, updateNeeded } from "../errors";
import { isSignedBy, type RunnerSigner } from "../keys";
import type { RunnerHello } from "../transport";

export const runnerConnectPath = "/api/runner/connect";

export const runnerRelayPath = "/api/runner/relay";

export const handshakeTimeoutMs = 10_000;

export const refusedCode = 1008;

export const updateNeededCode = 4001;

export const closeCodeOf = (refusal: unknown) =>
  hasCode(refusal, "update_needed") ? updateNeededCode : refusedCode;

// Undefined for a close after which the runner connects again.
export const refusalOf = (code: number, reason: string) => {
  if (code === updateNeededCode) return updateNeeded(reason);
  return code === refusedCode || (code >= 4000 && code <= 4999) ? refused(reason) : undefined;
};

// The server's first message of each socket.
const challengeMessageSchema = z.object({ challenge: z.string().min(1) });

// The runner's answer to the challenge, before any call.
const runnerHelloSchema = z.object({
  protocolVersion: z.number(),
  instanceId: z.string().min(1),
  publicKey: z.string().min(1),
  serverUrl: z.string().min(1),
  signature: z.string(),
}) satisfies z.ZodType<RunnerHello>;

export type SignedHello = z.infer<typeof runnerHelloSchema>;

const helloVersionSchema = runnerHelloSchema.pick({ protocolVersion: true });

const relayHelloSchema = runnerHelloSchema.extend({ relayId: z.string().min(1).max(64) });

export type SignedRelayHello = z.infer<typeof relayHelloSchema>;

type SignedFields = Omit<SignedHello, "signature"> & { relayId?: string };

const parseMessage = <T>(schema: z.ZodType<T>, text: string) => {
  try {
    return schema.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
};

export const parseChallenge = (text: string) =>
  parseMessage(challengeMessageSchema, text)?.challenge;

export const parseHello = (text: string) => parseMessage(runnerHelloSchema, text);

// Each version reads only this field first, so a hello of another shape still gets the version refusal.
export const parseHelloVersion = (text: string) =>
  parseMessage(helloVersionSchema, text)?.protocolVersion;

export const parseRelayHello = (text: string) => parseMessage(relayHelloSchema, text);

export const challengeOf = (challenge: string) => JSON.stringify({ challenge });

// The tag and `serverUrl` make the signature valid only for this hello to this server.
const signedPayload = (
  tag: string,
  challenge: string,
  { protocolVersion, instanceId, publicKey, serverUrl, relayId }: SignedFields,
) =>
  Buffer.from(
    JSON.stringify([
      tag,
      challenge,
      protocolVersion,
      instanceId,
      publicKey,
      serverUrl,
      ...(relayId === undefined ? [] : [relayId]),
    ]),
  );

const helloTag = "halinka-runner-hello-v2";
const relayTag = "halinka-runner-relay-v1";

type SignedHelloOptions = { hello: RunnerHello; signer: RunnerSigner; serverUrl: string };

export const signedHello = (
  challenge: string,
  { hello: { instanceId }, signer: { publicKey, sign }, serverUrl }: SignedHelloOptions,
) => {
  const hello = { protocolVersion, instanceId, publicKey, serverUrl };
  return JSON.stringify({ ...hello, signature: sign(signedPayload(helloTag, challenge, hello)) });
};

export const isSigned = (challenge: string, hello: SignedHello) =>
  isSignedBy(hello.publicKey, signedPayload(helloTag, challenge, hello), hello.signature);

type SignedRelayHelloOptions = SignedHelloOptions & { relayId: string };

export const signedRelayHello = (
  challenge: string,
  {
    hello: { instanceId },
    signer: { publicKey, sign },
    serverUrl,
    relayId,
  }: SignedRelayHelloOptions,
) => {
  const hello = { protocolVersion, instanceId, publicKey, serverUrl, relayId };
  return JSON.stringify({
    ...hello,
    signature: sign(signedPayload(relayTag, challenge, hello)),
  });
};

export const isSignedRelay = (challenge: string, hello: SignedRelayHello) =>
  isSignedBy(hello.publicKey, signedPayload(relayTag, challenge, hello), hello.signature);

export const relayAcceptMessage = JSON.stringify({ accepted: true });

const runnerAcceptSchema = z.object({
  accepted: z.literal(true),
  // The runner puts the id in paths.
  serverId: z.string().regex(/^[0-9a-f]{12}$/),
});

export const runnerAcceptOf = (serverId: string) => JSON.stringify({ accepted: true, serverId });

export const parseRunnerAccept = (text: string) => parseMessage(runnerAcceptSchema, text)?.serverId;

// birpc's listener rejects when it answers a call after the socket closed; the caller is gone.
export const ignoreRejection = (result: unknown) => void Promise.resolve(result).catch(() => {});

// birpc puts a failed call's error in `e`, and JSON drops an Error's fields.
export const codec = {
  serialize: (message: { e?: unknown }) =>
    JSON.stringify(
      message.e instanceof Error
        ? { ...message, e: { message: message.e.message, code: codeOf(message.e) } }
        : message,
    ),
  deserialize: (text: string) => {
    const message = JSON.parse(text) as { e?: { message: string; code?: unknown } };
    return message.e
      ? { ...message, e: Object.assign(new Error(message.e.message), { code: message.e.code }) }
      : message;
  },
};
