import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { findAgentPreset } from "@halinka/presets";
import { hashOf } from "@halinka/utils/hash";

import type { DbAgentCredential } from "./db/schema";

const keyLength = 32;
const nonceLength = 12;
const tagLength = 16;
const algorithm = "aes-256-gcm";

type CredentialPlace = Pick<DbAgentCredential, "preset" | "variable" | "memberId">;

type AppSecret = "private-key" | "webhook-secret";

export const parseMasterKey = (value: string) => {
  const text = value.trim();
  const key = Buffer.from(text, "base64");
  if (key.length !== keyLength || key.toString("base64") !== text) {
    throw new Error("HALINKA_MASTER_KEY must be 32 bytes in base64: openssl rand -base64 32");
  }
  return key;
};

export const credentialPlace = ({ preset, variable, memberId }: CredentialPlace) =>
  `agent-credential:${preset}:${variable}${memberId === null ? "" : `:${memberId}`}`;

export const repoSecretPlace = (repoId: number, name: string) => `repo-secret:${repoId}:${name}`;

export const appSecretPlace = (githubId: number, secret: AppSecret) =>
  `github-app:${githubId}:${secret}`;

export const appStatePlace = (memberId: number | undefined) =>
  `github-app-state:${memberId ?? "local"}`;

// `place` names where the value is stored, so a sealed value opens only there.
export class SecretCipher {
  constructor(private readonly key: Buffer) {}

  seal(place: string, value: string) {
    const nonce = randomBytes(nonceLength);
    const cipher = createCipheriv(algorithm, this.key, nonce).setAAD(Buffer.from(place));
    const text = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, text, cipher.getAuthTag()]).toString("base64");
  }

  // undefined: another master key, or another place
  open(place: string, sealed: string) {
    const bytes = Buffer.from(sealed, "base64");
    try {
      const decipher = createDecipheriv(algorithm, this.key, bytes.subarray(0, nonceLength))
        .setAAD(Buffer.from(place))
        .setAuthTag(bytes.subarray(-tagLength));
      return Buffer.concat([
        decipher.update(bytes.subarray(nonceLength, -tagLength)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      return undefined;
    }
  }
}

// A new seal has a new nonce, so a new value changes the hash.
type AgentFingerprintOptions = { version?: string; model?: string };

export const agentFingerprint = (
  preset: string,
  rows: Pick<DbAgentCredential, "variable" | "sealed">[],
  { version = findAgentPreset(preset)?.version, model }: AgentFingerprintOptions,
) => {
  const stored = rows
    .map(({ variable, sealed }) => [variable, sealed])
    .toSorted(([a = ""], [b = ""]) => a.localeCompare(b));
  return hashOf(JSON.stringify([version, model, stored]));
};

export const hasValidSignature = (secret: string, body: Buffer, signature: string | undefined) => {
  const hmac = createHmac("sha256", secret).update(body).digest("hex");
  const expected = Buffer.from(`sha256=${hmac}`);
  const sent = Buffer.from(signature ?? "");
  return sent.length === expected.length && timingSafeEqual(sent, expected);
};
