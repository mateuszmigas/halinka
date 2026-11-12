import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { lstat as stat, mkdir, readdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { createApiClient } from "@halinka/server/client";
import { errorMessage } from "@halinka/utils/errors";
import { ensureFolder, findRealPath, isFile, readTextFile, replaceFile } from "@halinka/utils/fs";
import { halinkaHome } from "@halinka/utils/halinkaHome";

import { readBuildId } from "./readBuild";
import { forwardStopSignals } from "./signals";

const run = promisify(execFile);

const downloadTimeoutMs = 5 * 60 * 1000;
const apiTimeoutMs = 30_000;
const activeStageMs = 60 * 60 * 1000;
// Then the runner waits for another build of the server.
const maxUpdateTries = 2;
const npmInstallTimeoutMs = 10 * 60 * 1000;

export type ServerPackage = { version: string; buildId: string; sha512: string; size: number };

type UpdateFailures = { buildId: string; count: number };

type RunBuildOptions = { signal?: AbortSignal; isForwardingStops?: boolean };

// The real path, so that two spellings of one home give one unit.
export const readRunnerHome = async () => {
  await ensureFolder(halinkaHome());
  return (await findRealPath(halinkaHome())) ?? halinkaHome();
};

export const versionsFolderOf = (home: string) => join(home, "versions");

const updateFailuresFileOf = (home: string) => join(versionsFolderOf(home), "update-failures.json");

// Each call of a runner to its server: a redirect could move the trust in the server to another origin.
export const runnerApiOf = (server: string, timeoutMs = apiTimeoutMs) =>
  createApiClient(server, {
    fetch: (request, init) =>
      fetch(request, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) }),
  });

// The code of the runner in an installed build, with the home of this runner.
export const runBuild = async (
  home: string,
  version: string,
  args: string[],
  { signal, isForwardingStops = false }: RunBuildOptions = {},
): Promise<number> => {
  const child = spawn(process.execPath, [mainOf(home, version), ...args], {
    env: { ...process.env, HALINKA_HOME: home },
    stdio: "inherit",
    ...(signal && { signal }),
  });
  const endForward = isForwardingStops ? forwardStopSignals(child) : () => {};
  const [code] = (await once(child, "exit")) as [number | null];
  endForward();
  return code ?? 1;
};

export const readCurrentVersion = (home: string) =>
  readlink(join(versionsFolderOf(home), "current")).catch(() => undefined);

// A failure of the server or the network, not of the build: it does not count as a failed try of the build.
export class UnreachableError extends Error {}

// Undefined: the server has no package, so a runner cannot install its build.
export const readServerPackage = async (server: string): Promise<ServerPackage | undefined> => {
  const manifest = await runnerApiOf(server).runner.manifest();
  return manifest.package && { ...manifest, ...manifest.package };
};

export const noPackageReason = (server: string) =>
  `${server} has no package for runners. Run the server from its Docker image`;

const readUpdateFailures = async (home: string) => {
  const text = await readTextFile(updateFailuresFileOf(home));
  return text === undefined ? undefined : (JSON.parse(text) as UpdateFailures);
};

// The state that stops a loop of restarts into a build that fails.
export const canTryBuild = async (home: string, buildId: string) => {
  const failures = await readUpdateFailures(home);
  return failures?.buildId !== buildId || failures.count < maxUpdateTries;
};

export const clearUpdateFailures = (home: string) =>
  rm(updateFailuresFileOf(home), { force: true });

export const recordUpdateFailure = async (home: string, buildId: string) => {
  const failures = await readUpdateFailures(home);
  const count = failures?.buildId === buildId ? failures.count + 1 : 1;
  await replaceFile(updateFailuresFileOf(home), JSON.stringify({ buildId, count }));
};

// Also deletes the stage folders that a failed install left.
export const deleteOtherVersions = async (home: string, kept: string[]) => {
  const versions = versionsFolderOf(home);
  const names = new Set(["current", "update-failures.json", ...kept]);
  for (const name of await readdir(versions)) {
    if (names.has(name) || (await isActiveStage(join(versions, name)))) continue;
    await rm(join(versions, name), { recursive: true, force: true });
  }
};

// An `install` can stage a build while the service updates: a young stage folder is in use.
const isActiveStage = async (path: string) => {
  if (!/\/\.(stage|current)-[^/]+$/.test(path)) return false;
  const { mtimeMs } = await stat(path);
  return Date.now() - mtimeMs < activeStageMs;
};

const distFolderOf = (versionFolder: string) =>
  join(versionFolder, "node_modules", "halinka", "dist");

export const mainOf = (home: string, version: string) =>
  join(distFolderOf(join(versionsFolderOf(home), version)), "main.js");

export const currentMainOf = (home: string) => mainOf(home, "current");

const versionNameOf = ({ version, buildId }: Pick<ServerPackage, "version" | "buildId">) =>
  `${version}-${buildId.slice(0, 12)}`;

const installedBuildIdOf = (versionFolder: string) =>
  readBuildId(join(distFolderOf(versionFolder), "build.json"));

const downloadPackage = async (server: string, file: string, expected: ServerPackage) => {
  const response = await fetch(new URL("/api/runner/package", server), {
    // A redirect could move the trust in the server to another origin.
    redirect: "error",
    signal: AbortSignal.timeout(downloadTimeoutMs),
  }).catch((error: unknown) => {
    throw new UnreachableError(`The server did not give its package: ${errorMessage(error)}`);
  });
  if (!response.ok || !response.body) {
    throw new UnreachableError(`The server answered ${response.status} for its package`);
  }
  const hash = createHash("sha512");
  let size = 0;
  const counted = new Transform({
    transform: (chunk: Buffer, _, done) => {
      size += chunk.length;
      if (size > expected.size) {
        return done(new Error("The package is larger than the manifest says"));
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), counted, createWriteStream(file)).catch(
    (error: unknown) => {
      if (size > expected.size) throw error;
      throw new UnreachableError(`The download of the package stopped: ${errorMessage(error)}`);
    },
  );
  if (size !== expected.size || hash.digest("hex") !== expected.sha512) {
    throw new Error("The package does not match the sha512 of the manifest");
  }
};

// The npm of this Node, run by this Node: the `npm` script runs the first `node` on `PATH`.
const npmCommand = async (): Promise<[string, string[]]> => {
  const npmCli = join(
    dirname(process.execPath),
    "..",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  return (await isFile(npmCli)) ? [process.execPath, [npmCli]] : ["npm", []];
};

// The version names a folder, so it must not hold a path.
const versionNamePattern = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

const npmInstall = async (folder: string, file: string) => {
  const [command, npmArgs] = await npmCommand();
  await run(
    command,
    [
      ...npmArgs,
      "install",
      "--prefix",
      folder,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--engine-strict",
      "--omit=dev",
      file,
    ],
    { timeout: npmInstallTimeoutMs },
  );
};

export const installServerPackage = async (
  server: string,
  home: string,
  expected: ServerPackage,
) => {
  if (!versionNamePattern.test(expected.version) || !/^[0-9a-f]{12,}$/.test(expected.buildId)) {
    throw new Error("The server gave a version or a build id that cannot name a folder");
  }
  const versions = versionsFolderOf(home);
  const name = versionNameOf(expected);
  const target = join(versions, name);
  if ((await installedBuildIdOf(target)) === expected.buildId) return name;
  const stage = join(versions, `.stage-${randomUUID()}`);
  await mkdir(stage, { recursive: true });
  try {
    const file = join(stage, "halinka.tgz");
    await downloadPackage(server, file, expected);
    await npmInstall(stage, file);
    await rm(file);
    if ((await installedBuildIdOf(stage)) !== expected.buildId) {
      throw new Error("The installed package has another build id than the server");
    }
    await rm(target, { recursive: true, force: true });
    await rename(stage, target);
    return name;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
};

// One rename replaces the link, so a start always finds `current`.
export const switchCurrent = async (home: string, name: string) => {
  const versions = versionsFolderOf(home);
  const next = join(versions, `.current-${randomUUID()}`);
  await symlink(name, next);
  await rename(next, join(versions, "current"));
};
