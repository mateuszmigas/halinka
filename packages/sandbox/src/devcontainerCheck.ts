import { isAbsolute } from "node:path";

import { isRecord } from "@halinka/utils/isRecord";

import {
  allowedCapabilities,
  allowedPropagations,
  isReservedLabel,
  isString,
  Problems,
  reachesHost,
  type RealFolders,
  text,
} from "./checkRules";

export type CheckFolders = RealFolders & { configFolder: string };

type Config = Record<string, unknown>;

const allowedKeys = new Set([
  "name",
  "image",
  "build",
  "dockerFile",
  "context",
  "dockerComposeFile",
  "service",
  "runServices",
  "workspaceFolder",
  "workspaceMount",
  "features",
  "overrideFeatureInstallOrder",
  "forwardPorts",
  "portsAttributes",
  "otherPortsAttributes",
  "containerEnv",
  "remoteEnv",
  "containerUser",
  "remoteUser",
  "updateRemoteUserUID",
  "userEnvProbe",
  "overrideCommand",
  "shutdownAction",
  "init",
  "privileged",
  "capAdd",
  "securityOpt",
  "mounts",
  "runArgs",
  "entrypoints",
  "customizations",
  "onCreateCommand",
  "updateContentCommand",
  "postCreateCommand",
  "postStartCommand",
  "postAttachCommand",
  "onCreateCommands",
  "updateContentCommands",
  "postCreateCommands",
  "postStartCommands",
  "postAttachCommands",
  "waitFor",
  "hostRequirements",
  "configFilePath",
]);

const allowedBuildKeys = new Set(["dockerfile", "context", "args", "target", "cacheFrom"]);

const valueFlags = new Set([
  "--env",
  "--label",
  "--hostname",
  "--shm-size",
  "--ulimit",
  "--tmpfs",
  "--add-host",
  "--cap-drop",
  "--user",
  "--workdir",
  "--platform",
]);

const shortFlags: Record<string, string> = {
  e: "--env",
  l: "--label",
  h: "--hostname",
  u: "--user",
  w: "--workdir",
};

const mountKeyAliases: Record<string, string> = {
  src: "source",
  dst: "target",
  destination: "target",
  ro: "readonly",
};

const mountKeys: Record<string, Set<string>> = {
  bind: new Set(["type", "source", "target", "readonly", "consistency", "bind-propagation"]),
  tmpfs: new Set(["type", "target", "tmpfs-size", "tmpfs-mode"]),
};

// The CLI writes these values into its compose file without escaping them.
const namePatterns: Record<string, RegExp> = {
  service: /^[a-zA-Z0-9][\w.-]*$/,
  containerUser: /^[\w.-]+(:[\w.-]+)?$/,
};
const variableNamePattern = /^[A-Za-z_]\w*$/;

const unsafeEntrypointPattern = /["\\\r\n]/;

const splitFlag = (arg: string) => {
  if (arg.startsWith("--")) {
    const [flag, value] = arg.split(/=(.*)/s, 2);
    return { flag, value };
  }
  const short = /^-([a-zA-Z])(=?)(.*)$/s.exec(arg);
  if (!short) return {};
  const [, letter = "", equals, rest] = short;
  return { flag: shortFlags[letter], value: equals || rest ? rest : undefined };
};

const flagValueProblems = (flag: string, value: string) => {
  if (flag === "--label" && isReservedLabel(value)) return [`runArgs: label ${value} is reserved`];
  if (flag === "--add-host" && reachesHost(value)) {
    return [`runArgs: --add-host ${value} reaches the host`];
  }
  return [];
};

const runArgsProblems = (runArgs: string[]) => {
  const problems: string[] = [];
  const args = runArgs.values();
  for (const arg of args) {
    if (arg === "--init") continue;
    const { flag, value } = splitFlag(arg);
    if (!flag || !valueFlags.has(flag)) {
      problems.push(`runArgs: ${arg} is not allowed`);
      continue;
    }
    const flagValue = value ?? args.next().value;
    if (flagValue === undefined || flagValue.startsWith("-")) {
      problems.push(`runArgs: ${arg} needs a value`);
    } else problems.push(...flagValueProblems(flag, flagValue));
  }
  return problems;
};

// The CLI joins the fields of an object mount without quotes.
const cliMount = (mount: unknown) =>
  isRecord(mount)
    ? [
        `type=${text(mount.type)}`,
        ...(mount.source ? [`src=${text(mount.source)}`] : []),
        `dst=${text(mount.target)}`,
      ].join(",")
    : mount;

// Without quotes and line breaks, Docker's CSV parser splits a mount as this does.
const mountEntries = (mount: string) =>
  mount.split(",").map((part) => {
    const [key = "", value = "true"] = part.split(/=(.*)/s, 2);
    return [mountKeyAliases[key] ?? key, value] as const;
  });

export const checkDevcontainer = async (config: Config, folders: CheckFolders) => {
  const { treeFolder, workspaceFolder, configFolder } = folders;
  const problems = new Problems();

  const checkTreePath = (where: string, path: unknown) => {
    if (path !== undefined)
      problems.checkInside(where, path, {
        folder: treeFolder,
        folderName: "repository",
        base: configFolder,
      });
  };

  const checkMount = (where: string, mount: unknown) => {
    const value = cliMount(mount);
    // In a compose config, the CLI writes a mount without escaping `$`.
    if (!isString(value) || /["\r\n$]/.test(value)) {
      problems.add(`${where} must be a string or an object without quotes, line breaks or "$"`);
      return;
    }
    const entries = mountEntries(value);
    const options = new Map(entries);
    if (options.size < entries.length) {
      problems.add(`${where}: a key is given more than once`);
      return;
    }
    const type = options.get("type") ?? "volume";
    const keys = mountKeys[type];
    if (!keys) {
      problems.add(`${where}: type ${type} is not allowed`);
      return;
    }
    for (const [key, value] of entries) {
      if (!keys.has(key)) problems.add(`${where}: ${key} is not allowed`);
      if (value.includes("=")) problems.add(`${where}: the value of ${key} holds "="`);
      if (key === "bind-propagation" && !allowedPropagations.has(value)) {
        problems.add(`${where}: bind-propagation ${value} is not allowed`);
      }
    }
    if (type !== "bind") return;
    const source = options.get("source");
    if (source && isAbsolute(source)) {
      problems.checkInside(where, source, { folder: workspaceFolder, folderName: "workspace" });
    } else problems.add(`${where}: a bind needs an absolute source`);
  };

  problems.keysOf("devcontainer.json", config, allowedKeys);
  if (config.privileged) problems.add("privileged is not allowed");
  problems.valuesOf("capAdd", config.capAdd, (value) => allowedCapabilities.has(value));
  // A security option can disable seccomp or AppArmor.
  problems.valuesOf("securityOpt", config.securityOpt, () => false);
  for (const problem of runArgsProblems(problems.stringsOf("runArgs", config.runArgs))) {
    problems.add(problem);
  }
  for (const [key, pattern] of Object.entries(namePatterns)) {
    problems.matches(key, config[key], pattern);
  }
  for (const name of Object.keys(problems.recordOf("containerEnv", config.containerEnv))) {
    if (!variableNamePattern.test(name)) problems.add(`containerEnv: ${name} is not allowed`);
  }
  problems.valuesOf(
    "entrypoints",
    config.entrypoints,
    (value) => !unsafeEntrypointPattern.test(value),
  );

  const build = problems.keysOf("build", config.build, allowedBuildKeys);
  checkTreePath("build.dockerfile", build.dockerfile);
  checkTreePath("build.context", build.context);
  checkTreePath("dockerFile", config.dockerFile);
  checkTreePath("context", config.context);

  const composeFiles = problems.stringsOf("dockerComposeFile", config.dockerComposeFile);
  if (
    config.dockerComposeFile !== undefined &&
    (composeFiles.length === 0 || composeFiles.includes(""))
  ) {
    problems.add("dockerComposeFile must name one or more files");
  }
  for (const file of composeFiles) checkTreePath("dockerComposeFile", file);

  for (const mount of [config.mounts ?? []].flat()) checkMount("mounts", mount);
  if (config.workspaceMount !== undefined) checkMount("workspaceMount", config.workspaceMount);
  return problems.all();
};

export const builtInFeaturePublisher = "ghcr.io/devcontainers/features/";

// The CLI reads a host without a dot as a GitHub repository, not as a registry.
const featurePublisherPattern = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(:\d+)?(\/[a-z0-9][a-z0-9._-]*)+\/$/;

// A registry on the runner host is not a publisher.
const isLoopback = (host: string) => host === "localhost" || /^(127\.|0\.0\.0\.0$)/.test(host);

// The CLI fetches a `devcontainers-contrib` Feature from `devcontainers-extra`.
const fetchedId = (id: string) => {
  const parts = id.toLowerCase().split("/");
  if (parts[1] === "devcontainers-contrib") parts[1] = "devcontainers-extra";
  return parts.join("/");
};

export const parseFeaturePublisher = (value: string) => {
  const publisher = value.toLowerCase();
  const host = featurePublisherPattern.exec(publisher)?.[1];
  return host === undefined || isLoopback(host) ? undefined : fetchedId(publisher);
};

const publisherOf = (ref: string) => parseFeaturePublisher(ref.slice(0, ref.lastIndexOf("/") + 1));

const featureProblem = (id: string, publishers: string[], ociRef?: string) => {
  const publisher = ociRef && publisherOf(ociRef);
  const hint = publisher
    ? `. To allow it, start the runner with --trust-features ${publisher}`
    : "";
  return `features: ${id} is not allowed. Use a Feature of ${publishers.join(", ")}${hint}`;
};

// The CLI writes through the symlinks of an extracted Feature.
const isTrusted = (id: string, publishers: string[]) =>
  publishers.some((publisher) => id.startsWith(publisher));

export const checkFeatureIds = async (
  {
    features,
    overrideFeatureInstallOrder,
  }: { features?: unknown; overrideFeatureInstallOrder?: unknown },
  publishers: string[],
) => {
  const problems = new Problems();
  const ids = [
    ...Object.keys(problems.recordOf("features", features)),
    ...problems.stringsOf("overrideFeatureInstallOrder", overrideFeatureInstallOrder),
  ];
  for (const id of ids) {
    if (!isTrusted(fetchedId(id), publishers)) problems.add(featureProblem(id, publishers, id));
  }
  return problems.all();
};

export type FeatureSet = {
  sourceInformation: {
    type: string;
    userFeatureId?: string;
    featureRef?: { registry?: string; path?: string };
  };
};

const fetchedRef = ({ registry, path }: { registry?: string; path?: string } = {}) =>
  registry === undefined || path === undefined ? undefined : `${registry}/${path}`;

// The sets also hold `dependsOn` Features, which `features` does not name.
export const checkFeatureSets = (featureSets: FeatureSet[], publishers: string[]) =>
  featureSets.flatMap(({ sourceInformation: { type, userFeatureId, featureRef } }) => {
    const ref = fetchedRef(featureRef);
    const ociRef = type === "oci" ? ref : undefined;
    if (ociRef !== undefined && isTrusted(ociRef, publishers)) return [];
    return [featureProblem(userFeatureId ?? ref ?? "a Feature", publishers, ociRef)];
  });
