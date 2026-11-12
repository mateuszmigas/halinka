import { createHash } from "node:crypto";

export const hashOf = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
