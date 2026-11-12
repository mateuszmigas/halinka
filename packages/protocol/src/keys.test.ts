import { describe, expect, it } from "vitest";

import {
  createKeyPair,
  isPublicKey,
  isSignedProbe,
  isSignedRegistration,
  isSignedStatus,
  type ProbeFields,
  signedProbe,
  signedRegistration,
  signedStatus,
  signerOf,
  type StatusFields,
} from "./keys";

const signer = signerOf(createKeyPair());
const host = { name: "build-1", os: "linux", arch: "x64" };
const status: StatusFields = {
  serverUrl: "https://halinka.example.com",
  sentAt: 1,
  status: "update_failed",
  buildId: "build",
  reason: "npm failed",
};

const probe: ProbeFields = {
  serverUrl: "https://halinka.example.com",
  protocolVersion: 19,
  build: { version: "0.0.1", id: "build" },
  sentAt: 1,
};

describe("keys", () => {
  it("accepts a public key that it created", () => {
    expect(isPublicKey(createKeyPair().publicKey)).toBe(true);
  });

  it.each([
    ["with padding", `${signer.publicKey}=`],
    ["in standard base64", Buffer.from(signer.publicKey, "base64url").toString("base64")],
    ["of another length", Buffer.alloc(31).toString("base64url")],
  ])("refuses a public key %s", (_, key) => {
    expect(isPublicKey(key)).toBe(false);
  });

  it("accepts a registration that the key signed", () => {
    expect(isSignedRegistration(signedRegistration(signer, host))).toBe(true);
  });

  it("refuses a registration whose host changed after the signature", () => {
    const registration = { ...signedRegistration(signer, host), name: "other" };

    expect(isSignedRegistration(registration)).toBe(false);
  });

  it("accepts a status that the key signed", () => {
    expect(isSignedStatus(signedStatus(signer, status))).toBe(true);
  });

  it("refuses a status whose reason changed after the signature", () => {
    expect(isSignedStatus({ ...signedStatus(signer, status), reason: "other" })).toBe(false);
  });

  it("accepts a probe that the key signed", () => {
    expect(isSignedProbe(signedProbe(signer, probe))).toBe(true);
  });

  it.each<[string, Partial<ProbeFields>]>([
    ["server URL", { serverUrl: "https://other.example.com" }],
    ["protocol version", { protocolVersion: 18 }],
    ["build", { build: { version: "0.0.1", id: "other" } }],
    ["time", { sentAt: 2 }],
  ])("refuses a probe whose %s changed after the signature", (_, change) => {
    expect(isSignedProbe({ ...signedProbe(signer, probe), ...change })).toBe(false);
  });
});
