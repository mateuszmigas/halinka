import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

import type { Build } from "./controlPlane";

// Ed25519 as base64url: the public key is the JWK `x`, the private key the JWK `d`.
export type KeyPair = { publicKey: string; privateKey: string };

// `sign` uses the private key of `publicKey` and gives the signature as base64url.
export type RunnerSigner = { publicKey: string; sign: (payload: Buffer) => string };

export const createKeyPair = (): KeyPair => {
  const { x = "", d = "" } = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  return { publicKey: x, privateKey: d };
};

export const signerOf = ({ publicKey, privateKey }: KeyPair): RunnerSigner => {
  const key = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", x: publicKey, d: privateKey },
    format: "jwk",
  });
  return { publicKey, sign: (payload) => sign(null, payload, key).toString("base64url") };
};

export const isSignedBy = (publicKey: string, payload: Buffer, signature: string) => {
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: publicKey },
      format: "jwk",
    });
    return verify(null, payload, key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
};

// Node also accepts other spellings of a key (padding, standard base64): store only this one.
export const isPublicKey = (value: string) => {
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value;
};

export type RunnerHost = { name: string; os: string; arch: string };

export type SignedRegistration = RunnerHost & { publicKey: string; signature: string };

// The tag makes the signature valid only for a registration.
const registrationPayload = (publicKey: string, { name, os, arch }: RunnerHost) =>
  Buffer.from(JSON.stringify(["halinka-runner-registration-v1", publicKey, name, os, arch]));

export const signedRegistration = (signer: RunnerSigner, host: RunnerHost): SignedRegistration => ({
  ...host,
  publicKey: signer.publicKey,
  signature: signer.sign(registrationPayload(signer.publicKey, host)),
});

export const isSignedRegistration = ({
  publicKey,
  signature,
  name,
  os,
  arch,
}: SignedRegistration) =>
  isSignedBy(publicKey, registrationPayload(publicKey, { name, os, arch }), signature);

export type ProbeFields = {
  serverUrl: string;
  protocolVersion: number;
  build: Build;
  sentAt: number;
};

export type SignedProbe = ProbeFields & { publicKey: string; signature: string };

// The origin and the time make the signature valid only for this server, for a short time.
const probePayload = (
  publicKey: string,
  { serverUrl, protocolVersion, build, sentAt }: ProbeFields,
) =>
  Buffer.from(
    JSON.stringify([
      "halinka-runner-probe-v1",
      publicKey,
      serverUrl,
      protocolVersion,
      build.version,
      build.id,
      sentAt,
    ]),
  );

export const signedProbe = (signer: RunnerSigner, fields: ProbeFields): SignedProbe => ({
  ...fields,
  publicKey: signer.publicKey,
  signature: signer.sign(probePayload(signer.publicKey, fields)),
});

export const isSignedProbe = ({ publicKey, signature, ...fields }: SignedProbe) =>
  isSignedBy(publicKey, probePayload(publicKey, fields), signature);

export type StatusFields = {
  serverUrl: string;
  sentAt: number;
  status: "update_failed";
  // the build that the runner did not install
  buildId: string;
  reason: string;
};

export type SignedStatus = StatusFields & { publicKey: string; signature: string };

const statusPayload = (
  publicKey: string,
  { serverUrl, sentAt, status, buildId, reason }: StatusFields,
) =>
  Buffer.from(
    JSON.stringify([
      "halinka-runner-status-v1",
      publicKey,
      serverUrl,
      sentAt,
      status,
      buildId,
      reason,
    ]),
  );

export const signedStatus = (signer: RunnerSigner, fields: StatusFields): SignedStatus => ({
  ...fields,
  publicKey: signer.publicKey,
  signature: signer.sign(statusPayload(signer.publicKey, fields)),
});

export const isSignedStatus = ({ publicKey, signature, ...fields }: SignedStatus) =>
  isSignedBy(publicKey, statusPayload(publicKey, fields), signature);
