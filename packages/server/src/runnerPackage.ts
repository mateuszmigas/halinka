import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

export type RunnerPackage = { path: string; sha512: string; size: number };

export const readRunnerPackage = async (path: string): Promise<RunnerPackage> => {
  const hash = createHash("sha512");
  const [, { size }] = await Promise.all([pipeline(createReadStream(path), hash), stat(path)]);
  return { path, sha512: hash.digest("hex"), size };
};
