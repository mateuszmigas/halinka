import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { type Build, buildSchema } from "@halinka/protocol";
import { readTextFile } from "@halinka/utils/fs";

const sourceBuildId = "source";

// Undefined for code run from source, which has no build.json.
export const readBuildId = async (buildFile: string) => {
  const text = await readTextFile(buildFile);
  return text === undefined ? undefined : buildSchema.shape.id.parse(JSON.parse(text).id);
};

export const readBuild = async (): Promise<Build> => {
  const { version } = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const buildFile = fileURLToPath(new URL("./build.json", import.meta.url));
  return { version: String(version), id: (await readBuildId(buildFile)) ?? sourceBuildId };
};
