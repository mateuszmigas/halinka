import { isIP } from "node:net";
import { parseArgs, type ParseArgsConfig, type ParseArgsOptionsConfig } from "node:util";

import { sandboxKinds } from "@halinka/protocol";
import { parseFeaturePublisher } from "@halinka/sandbox/devcontainer";
import { errorMessage } from "@halinka/utils/errors";

import { defaultPort } from "./localServerUrl";

export const fail = (message: string, exitCode = 1): never => {
  console.error(message);
  process.exit(exitCode);
};

export const failWithError = (error: unknown): never => fail(errorMessage(error));

export const failWithUsage = (message: string, usage: string): never => {
  console.error(`${message}\n\n${usage}`);
  process.exit(1);
};

const parseOrFail = <T extends ParseArgsConfig>(config: T, usage: string) => {
  if (config.args?.includes("--help") || config.args?.includes("-h")) {
    console.log(usage);
    process.exit(0);
  }
  try {
    return parseArgs(config);
  } catch (error) {
    return failWithUsage((error as Error).message, usage);
  }
};

// `--help` shows the usage. Unknown flags are errors, and an error also shows the usage.
export const parseCommandArgs = <T extends ParseArgsOptionsConfig>(
  args: string[],
  options: T,
  usage: string,
) => parseOrFail({ args, options, strict: true }, usage).values;

export const parseCommandWithPositionals = <T extends ParseArgsOptionsConfig>(
  args: string[],
  options: T,
  usage: string,
) => parseOrFail({ args, options, strict: true, allowPositionals: true }, usage);

export const portFlag = {
  usage: `  --port <number>                    The port of the server and the portal, 0 for any free port (default: ${defaultPort})`,
  option: { port: { type: "string", default: String(defaultPort) } },
} as const;

export const parsePort = (value: string, usage: string) => {
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65535
    ? port
    : failWithUsage(`--port must be a number from 0 to 65535. Got "${value}".`, usage);
};

const runsInFlag = {
  usage:
    "  --runs-in <devcontainer|worktree>  Where the runner runs workflows (default: devcontainer)",
  option: { "runs-in": { type: "string", default: "devcontainer" } },
} as const;

const capacityFlag = {
  usage:
    "  --capacity <number>                The runs that execute at one time; a run that waits for a person does not count (default: 4)",
  option: { capacity: { type: "string", default: "4" } },
} as const;

export const parseCapacity = (value: string, usage: string) => {
  const capacity = Number(value);
  return Number.isInteger(capacity) && capacity >= 1
    ? capacity
    : failWithUsage(`--capacity must be a whole number of 1 or more. Got "${value}".`, usage);
};

const reachFlag = {
  usage:
    "  --reach <address|cidr>             A private address that steps in a devcontainer can reach, such as a LAN service (repeat it)",
  option: { reach: { type: "string", multiple: true, default: [] as string[] } },
} as const;

const isReachable = (value: string) => {
  const [address = "", prefix, ...rest] = value.split("/");
  const version = isIP(address);
  if (version === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  return /^\d+$/.test(prefix) && Number(prefix) <= (version === 4 ? 32 : 128);
};

export const parseReach = (values: string[], usage: string) => {
  const invalid = values.find((value) => !isReachable(value));
  return invalid === undefined
    ? values
    : failWithUsage(`--reach must be an IP address or a CIDR range. Got "${invalid}".`, usage);
};

const trustFeaturesFlag = {
  usage:
    "  --trust-features <registry/path/>  A publisher of devcontainer Features to trust, such as ghcr.io/acme/features/ (repeat it)",
  option: { "trust-features": { type: "string", multiple: true, default: [] as string[] } },
} as const;

export const parseFeaturePublishers = (values: string[], usage: string) =>
  values.map(
    (value) =>
      parseFeaturePublisher(value) ??
      failWithUsage(
        `--trust-features must be a registry with a dot in its name and a path that ends in /, not on the runner host, such as ghcr.io/acme/features/. Got "${value}".`,
        usage,
      ),
  );

const dockerInContainerFlag = {
  usage:
    "  --docker-in-container              Give Docker to the container of a run whose repo asks for it, with Sysbox (Linux only)",
  option: { "docker-in-container": { type: "boolean", default: false } },
} as const;

const limitFlags = {
  usage: [
    "  --memory <size>                    The memory of each container of a run, such as 8g or 512m (default: half of the Docker host memory)",
    "  --cpus <number>                    The CPUs of each container of a run, such as 2 or 0.5 (default: no limit)",
  ].join("\n"),
  option: { memory: { type: "string" }, cpus: { type: "string" } },
} as const;

const sizeUnits: Record<string, number> = { "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

// Docker refuses a memory limit below 6 MiB and a CPU limit below 0.01.
const minMemoryBytes = 6 * 1024 ** 2;
const minCpus = 0.01;

const parseMemory = (value: string | undefined, usage: string) => {
  if (value === undefined) return undefined;
  const [, amount = "", unit = ""] = /^(\d+(?:\.\d+)?)([bkmg]?)$/i.exec(value) ?? [];
  const bytes = Math.floor(Number(amount) * (sizeUnits[unit.toLowerCase()] ?? 0));
  return Number.isSafeInteger(bytes) && bytes >= minMemoryBytes
    ? bytes
    : failWithUsage(`--memory must be a size of 6m or more, such as 8g. Got "${value}".`, usage);
};

const parseCpus = (value: string | undefined, usage: string) => {
  if (value === undefined) return undefined;
  const cpus = Number(value);
  return Number.isFinite(cpus) && cpus >= minCpus
    ? cpus
    : failWithUsage(`--cpus must be a number of 0.01 or more, such as 2. Got "${value}".`, usage);
};

export const parseLimits = (values: { memory?: string; cpus?: string }, usage: string) => ({
  memory: parseMemory(values.memory, usage),
  cpus: parseCpus(values.cpus, usage),
});

const parseRunsIn = (value: string, usage: string) =>
  sandboxKinds.find((kind) => kind === value) ??
  failWithUsage(`Unknown --runs-in "${value}".`, usage);

export const runnerFlags = {
  usage: [
    runsInFlag.usage,
    capacityFlag.usage,
    reachFlag.usage,
    trustFeaturesFlag.usage,
    dockerInContainerFlag.usage,
    limitFlags.usage,
  ].join("\n"),
  option: {
    ...runsInFlag.option,
    ...capacityFlag.option,
    ...reachFlag.option,
    ...trustFeaturesFlag.option,
    ...dockerInContainerFlag.option,
    ...limitFlags.option,
  },
} as const;

type RunnerFlagValues = {
  "runs-in": string;
  capacity: string;
  reach: string[];
  "trust-features": string[];
  "docker-in-container": boolean;
  memory?: string;
  cpus?: string;
};

export const parseRunnerFlags = (flags: RunnerFlagValues, usage: string) => ({
  sandboxKind: parseRunsIn(flags["runs-in"], usage),
  capacity: parseCapacity(flags.capacity, usage),
  reachable: parseReach(flags.reach, usage),
  featurePublishers: parseFeaturePublishers(flags["trust-features"], usage),
  isDockerInContainer: flags["docker-in-container"],
  limits: parseLimits(flags, usage),
});
