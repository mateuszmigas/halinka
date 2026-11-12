import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { abortError, errorMessage } from "@halinka/utils/errors";

import { movedBindSource, type RealFolders } from "./checkRules";
import { checkCompose, checkComposeSources } from "./composeCheck";
import { checkStartedContainer, type StartedContainer } from "./containerCheck";
import { containerProcesses, remoteUserOf } from "./containerProcesses";
import {
  builtInFeaturePublisher,
  type CheckFolders,
  checkDevcontainer,
  checkFeatureIds,
  checkFeatureSets,
  type FeatureSet,
  parseFeaturePublisher,
} from "./devcontainerCheck";
import {
  agentUser,
  sysboxRuntime,
  docker,
  dockerLines,
  nameLabel,
  networkLabel,
  output,
  rootExec,
  shortCall,
  spawnWithEnvFile,
  splitEnvironment,
} from "./docker";
import { InnerDocker } from "./dockerInside";
import {
  checkedCommand,
  collectOutput,
  execWithin,
  type StartedProcess,
  toSandboxProcess,
} from "./process";
import {
  type EgressPolicy,
  type GrantOptions,
  isolatedGateway,
  proxyEnvironment,
  proxyImage,
  startRunNetwork,
} from "./runNetwork";
import {
  type ExecOptions,
  type Sandbox,
  sandboxCallTimeoutMs,
  sandboxGitTimeoutMs,
  type SandboxUser,
  type SpawnOptions,
  type WorkspaceOwner,
} from "./sandbox";

export type { ContainerProcesses } from "./containerProcesses";
export { parseFeaturePublisher } from "./devcontainerCheck";
export { agentUser, sysboxRuntime } from "./docker";
export {
  createProxyTls,
  type Credential,
  EgressPolicy,
  type EgressPolicyOptions,
  proxyRouteUrl,
  proxyTlsRouteUrl,
} from "./runNetwork";

const cli = createRequire(import.meta.url).resolve("@devcontainers/cli/devcontainer.js");

const projectLabel = "com.docker.compose.project";
const serviceLabel = "com.docker.compose.service";

// The compose check reserves this name, so no project network has it.
const runNetworkKey = "halinka";

const maxPids = 4096;

const agentEnvironment = { HOME: `/home/${agentUser}`, USER: agentUser, LOGNAME: agentUser };

const hostOwner = () => `${process.getuid!()}:${process.getgid!()}`;

// `memory` in bytes. Each container of the run gets the whole limit.
export type ContainerLimits = { memory?: number; cpus?: number };

type RunLimits = { memory: number; cpus?: number };

type DockerHost = { memory: number; cpus: number };

export type DevcontainerOptions = {
  name: string;
  workspaceFolder: string;
  // The build reads this tree; the containers mount `workspaceFolder` in its place.
  treeFolder: string;
  // relative to `treeFolder`
  configPath: string;
  setupNetwork: GrantOptions["hosts"];
  policy: EgressPolicy;
  limits?: ContainerLimits;
  featurePublishers?: string[];
  isDockerInside?: boolean;
};

export type Devcontainer = {
  containerId: string;
  remoteUser: string;
  remoteWorkspaceFolder: string;
  // the compose services, for NO_PROXY
  noProxy: string[];
  isDockerInside: boolean;
};

type ComposeService = {
  image?: string;
  platform?: string;
  volumes?: { type: string; source?: string }[];
  networks?: Record<string, unknown>;
  network_mode?: string;
};

type ComposeDocument = {
  services: Record<string, ComposeService>;
  networks?: Record<string, unknown>;
};

type Config = {
  image?: string;
  build?: unknown;
  dockerFile?: unknown;
  service?: string;
  dockerComposeFile?: string | string[];
  features?: unknown;
  configFilePath?: unknown;
  remoteEnv?: Record<string, string>;
  runArgs?: string[];
};

const dockerVariables = [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION",
];

// The CLI prints its result as the last line of stdout, also when it fails.
const devcontainer = async <T>(args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) => {
  const { stdout, stderr } = await output(process.execPath, [cli, ...args], { env, signal });
  const line = stdout.trim().split("\n").at(-1);
  if (!line) throw new Error(stderr.trim().split("\n").at(-1) || `devcontainer ${args[0]} failed`);
  const result = JSON.parse(line) as
    | { outcome: "error"; message: string; description?: string }
    | (T & { outcome?: "success" });
  if (result.outcome === "error") {
    throw new Error([result.message, result.description].filter(Boolean).join(": "));
  }
  return result;
};

// The CLI and compose fill `${localEnv:...}` and `${VAR}` from this environment.
const cliEnvironment = (home: string, project?: string): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(dockerVariables.map((name) => [name, process.env[name]])),
  PATH: process.env.PATH,
  TMPDIR: tmpdir(),
  HOME: home,
  DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? join(homedir(), ".docker"),
  COMPOSE_PROJECT_NAME: project,
});

const withCliEnvironment = async <T>(
  project: string | undefined,
  run: (env: NodeJS.ProcessEnv, folder: string) => Promise<T>,
) => {
  const folder = await mkdtemp(join(tmpdir(), "halinka-devcontainer-"));
  try {
    const home = join(folder, "home");
    await mkdir(home);
    return await run(cliEnvironment(home, project), folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
};

const readComposeDocument = async (
  files: string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) => {
  const fileArgs = files.flatMap((file) => ["-f", file]);
  const config = await docker(
    ["compose", ...fileArgs, "--profile", "*", "config", "--format", "json", "--no-env-resolution"],
    { env, signal },
  );
  // The output writes each `$` as `$$`.
  return JSON.parse(config, (_, value: unknown) =>
    typeof value === "string" ? value.replaceAll("$$", "$") : value,
  ) as ComposeDocument;
};

// On Docker Desktop the Docker host is its VM, not the computer.
const inspectDockerHost = async (): Promise<DockerHost> => {
  const [memory = 0, cpus = 0] = (await dockerLines("info", "--format", "{{.MemTotal}} {{.NCPU}}"))
    .join(" ")
    .split(" ")
    .map(Number);
  return { memory, cpus };
};

export const runLimits = ({ memory, cpus }: ContainerLimits, host: DockerHost): RunLimits => ({
  memory: memory ?? Math.floor(host.memory / 2),
  cpus,
});

// Without `--memory-swap`, Docker adds swap of the same size as the memory limit.
const memoryArgs = (memory: number) => [
  "--memory",
  String(memory),
  "--memory-swap",
  String(memory),
];

const limitArgs = ({ memory, cpus }: RunLimits) => [
  "--pids-limit",
  String(maxPids),
  ...memoryArgs(memory),
  ...(cpus === undefined ? [] : ["--cpus", String(cpus)]),
];

// `hostCpus`: `docker update --cpus 0` keeps a CPU limit, so all CPUs of the host remove it.
export const limitUpdateArgs = ({ memory, cpus }: RunLimits, hostCpus: number) => [
  ...memoryArgs(memory),
  "--cpus",
  String(cpus ?? hostCpus),
];

// Compose refuses two different values for the two keys of one limit.
const composeLimits = ({ memory, cpus }: RunLimits) => {
  const limit = String(memory);
  return {
    pids_limit: maxPids,
    mem_limit: limit,
    memswap_limit: limit,
    cpus,
    deploy: { resources: { limits: { pids: maxPids, memory: limit, cpus } } },
  };
};

// `up` keeps a container that exists, so its limits can be from an earlier runner.
const updateLimits = async (ids: string[], limits: RunLimits, hostCpus: number) => {
  if (ids.length === 0) return;
  await docker(["update", ...limitUpdateArgs(limits, hostCpus), ...ids], shortCall);
};

type ProjectOverrideOptions = {
  folders: RealFolders;
  runNetwork: string;
  limits: RunLimits;
  sysboxService?: string;
};

// Compose resolves a bind such as `..` against the compose file, which is in the tree.
const projectOverride = (
  { services, networks = {} }: ComposeDocument,
  { folders, runNetwork, limits, sysboxService }: ProjectOverrideOptions,
) => {
  const changed = Object.entries(services).map(([service, settings]) => {
    const binds = (settings.volumes ?? []).flatMap((volume) => {
      const source =
        volume.type === "bind" && volume.source
          ? movedBindSource(volume.source, folders)
          : undefined;
      return source ? [{ ...volume, source }] : [];
    });
    // Compose refuses `networks` together with `network_mode`.
    const attached = settings.network_mode
      ? {}
      : { networks: { ...settings.networks, [runNetworkKey]: {} } };
    const runtime = service === sysboxService ? { runtime: sysboxRuntime } : {};
    // Docker starts a service with `restart: always` again when Docker restarts.
    return [
      service,
      { volumes: binds, restart: "no", ...composeLimits(limits), ...runtime, ...attached },
    ];
  });
  return {
    services: Object.fromEntries(changed),
    // Only the run network reaches the proxy.
    networks: {
      ...Object.fromEntries(
        Object.keys(networks).map((key) => [key, { internal: true, driver_opts: isolatedGateway }]),
      ),
      [runNetworkKey]: { name: runNetwork, external: true },
    },
  };
};

const writeComposeOverride = async (file: string, override: object) => {
  // Compose reads a `$` in the override as the start of a variable.
  const text = JSON.stringify(override, (_, value: unknown) =>
    typeof value === "string" ? value.replaceAll("$", () => "$$") : value,
  );
  await writeFile(file, text);
  return file;
};

const requireNoProblems = (problems: string[]) => {
  if (problems.length > 0) {
    throw new Error(`The devcontainer configuration is not allowed:\n${problems.join("\n")}`);
  }
};

const publishersOf = (values: string[]) =>
  values.map((value) => {
    const publisher = parseFeaturePublisher(value);
    if (publisher === undefined) throw new Error(`The Feature publisher "${value}" is not valid`);
    return publisher;
  });

type PinOptions = {
  name: string;
  platform: string | undefined;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

const platformOf = (runArgs: string[]) => {
  const index = runArgs.findIndex((arg) => /^--platform(=|$)/.test(arg));
  const arg = runArgs[index];
  if (arg === undefined) return undefined;
  return arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : runArgs[index + 1];
};

// An image ID or a digest cannot move.
const isFixedImage = (reference: string) => /^sha256:|@sha256:/.test(reference);

// `up` reads the image metadata again; the tag makes it read the checked image.
const withPinnedImage = async <T>(
  reference: string | undefined,
  { name, platform, env, signal }: PinOptions,
  run: (image: string | undefined) => Promise<T>,
) => {
  if (!reference || isFixedImage(reference)) return run(undefined);
  // A registry host that does not resolve: a lookup of the tag fails.
  const image = `halinka-pin.invalid/${name}:checked`;
  const tag = () => docker(["tag", reference, image], { env, signal });
  await tag().catch(async () => {
    const platformArgs = platform ? ["--platform", platform] : [];
    await docker(["pull", "--quiet", ...platformArgs, reference], { env, signal });
    await tag();
  });
  try {
    return await run(image);
  } finally {
    // A tag that stays holds nothing: the next `up` tags again.
    await docker(["image", "rm", "--force", image], shortCall).catch(() => {});
  }
};

type AllowedContainers = { ids: string[]; folders: RealFolders; sysboxId?: string };

// A Dockerfile FROM or a Compose build is not pinned, so `up` can add flags.
const requireAllowedContainers = async ({ ids, folders, sysboxId }: AllowedContainers) => {
  if (ids.length === 0) return;
  const format =
    '{"id":{{json .Id}},"name":{{json .Name}},"hostConfig":{{json .HostConfig}},"mounts":{{json .Mounts}}}';
  const inspected = (await dockerLines("inspect", "--format", format, ...ids)).map(
    (line) => JSON.parse(line) as StartedContainer & { id: string },
  );
  const problems = (
    await Promise.all(
      inspected.map(({ id, name, ...container }) =>
        checkStartedContainer(
          { ...container, name: name.slice(1) },
          folders,
          id === sysboxId ? sysboxRuntime : undefined,
        ),
      ),
    )
  ).flat();
  if (sysboxId && !inspected.some(({ id }) => id === sysboxId)) {
    problems.push(`The container ${sysboxId} with ${sysboxRuntime} is not a container of the run`);
  }
  if (problems.length === 0) return;
  await docker(["rm", "--force", "--volumes", ...ids], shortCall);
  throw new Error(`The container does not have the checked settings:\n${problems.join("\n")}`);
};

const bringUp = (options: DevcontainerOptions, signal?: AbortSignal) =>
  withCliEnvironment(options.name, async (env, folder) => {
    const [treeFolder, workspaceFolder] = await Promise.all([
      realpath(options.treeFolder),
      realpath(options.workspaceFolder),
    ]);
    const configPath = join(treeFolder, options.configPath);
    const folders: CheckFolders = {
      treeFolder,
      workspaceFolder,
      configFolder: dirname(configPath),
    };
    const target = [
      "--workspace-folder",
      workspaceFolder,
      "--config",
      configPath,
      "--id-label",
      `${nameLabel}=${options.name}`,
      "--mount-workspace-git-root=false",
      "--oci-auth-hardening",
    ];
    const publishers = [builtInFeaturePublisher, ...publishersOf(options.featurePublishers ?? [])];
    // Without include flags, `read-configuration` fetches no Feature.
    const { configuration } = await devcontainer<{ configuration: Config }>(
      ["read-configuration", ...target],
      env,
      signal,
    );
    requireNoProblems(await checkFeatureIds(configuration, publishers));
    const composeFiles = [configuration.dockerComposeFile ?? []]
      .flat()
      .map((file) => resolve(folders.configFolder, file));
    if (composeFiles.length > 0 && workspaceFolder.includes("$")) {
      throw new Error(
        `The workspace folder ${workspaceFolder} holds a $. The devcontainer CLI does not escape $ in a Compose file.`,
      );
    }
    requireNoProblems(await checkComposeSources(composeFiles, treeFolder));
    const compose =
      composeFiles.length > 0 ? await readComposeDocument(composeFiles, env, signal) : undefined;
    const { configFilePath: _, ...config } = configuration;
    const service = config.service ?? "";
    const reference = compose
      ? compose.services[service]?.image
      : config.build || config.dockerFile
        ? undefined
        : config.image;
    const platform = compose
      ? compose.services[service]?.platform
      : platformOf(config.runArgs ?? []);
    const pinOptions = { name: options.name, platform, env, signal };
    return withPinnedImage(reference, pinOptions, async (image) => {
      const pinFiles =
        compose && image
          ? [
              await writeComposeOverride(join(folder, "pin.json"), {
                services: { [service]: { image, pull_policy: "never" } },
              }),
            ]
          : [];
      const checkedComposeFiles = [...composeFiles, ...pinFiles];
      const pinned = compose
        ? { ...config, dockerComposeFile: checkedComposeFiles }
        : { ...config, ...(image && { image }) };
      const checkConfig = join(folder, "check.json");
      await writeFile(checkConfig, JSON.stringify(pinned));
      const { mergedConfiguration, featuresConfiguration } = await devcontainer<{
        mergedConfiguration: Record<string, unknown>;
        featuresConfiguration?: { featureSets: FeatureSet[] };
      }>(
        [
          "read-configuration",
          ...target,
          "--override-config",
          checkConfig,
          "--include-merged-configuration",
          "--include-features-configuration",
        ],
        env,
        signal,
      );
      requireNoProblems([
        ...checkFeatureSets(featuresConfiguration?.featureSets ?? [], publishers),
        ...(await checkDevcontainer(
          { ...mergedConfiguration, dockerComposeFile: configuration.dockerComposeFile },
          folders,
        )),
        ...(compose ? await checkCompose(compose, folders, options.name) : []),
      ]);
      const { policy } = options;
      const host = await inspectDockerHost();
      const limits = runLimits(options.limits ?? {}, host);
      const runNetwork = await startRunNetwork(options.name, signal);
      const noProxy = compose ? Object.keys(compose.services) : [];
      const network = compose
        ? {
            dockerComposeFile: [
              ...checkedComposeFiles,
              await writeComposeOverride(
                join(folder, "compose.json"),
                projectOverride(compose, {
                  folders,
                  runNetwork,
                  limits,
                  ...(options.isDockerInside && { sysboxService: service }),
                }),
              ),
            ],
          }
        : {
            runArgs: [
              ...(config.runArgs ?? []),
              "--network",
              runNetwork,
              ...limitArgs(limits),
              ...(options.isDockerInside ? [`--runtime=${sysboxRuntime}`] : []),
            ],
          };
      // A new token for each `up`: a process of an earlier `up` can hold the last one.
      const setupToken = randomUUID();
      const remoteEnv = { ...config.remoteEnv, ...proxyEnvironment(setupToken, noProxy) };
      const overrideConfig = join(folder, "devcontainer.json");
      // The CLI resolves the relative paths of an override config against `--config`.
      await writeFile(overrideConfig, JSON.stringify({ ...pinned, ...network, remoteEnv }));
      // `read-configuration` resolves Features without the lockfile.
      const up = ["up", ...target, "--no-lockfile", "--gpu-availability", "none"];
      await policy.grant({ hosts: options.setupNetwork }, setupToken);
      try {
        await restoreNetworks(
          options.name,
          { composeFiles: network.dockerComposeFile, env },
          signal,
        );
        const { containerId, remoteUser, remoteWorkspaceFolder } = await devcontainer<Devcontainer>(
          [...up, "--override-config", overrideConfig],
          env,
          signal,
        );
        const ids = await findRunContainers(options.name);
        const sysboxId = options.isDockerInside ? containerId : undefined;
        await requireAllowedContainers({ ids, folders, sysboxId });
        await updateLimits(ids, limits, host.cpus);
        const isDockerInside = options.isDockerInside ?? false;
        return { containerId, remoteUser, remoteWorkspaceFolder, noProxy, isDockerInside };
      } finally {
        await policy.revoke(setupToken);
      }
    });
  });

export const isDockerAvailable = () =>
  output("docker", ["version", "--format", "{{.Server.Version}}"], shortCall).then(
    ({ exitCode }) => exitCode === 0,
    () => false,
  );

export const hasSysboxRuntime = () =>
  output("docker", ["info", "--format", "{{json .Runtimes}}"], shortCall).then(
    ({ exitCode, stdout }) => exitCode === 0 && sysboxRuntime in JSON.parse(stdout),
    () => false,
  );

export type ContainerState = "running" | "stopped" | "absent";

const stateOf = (states: string[]): ContainerState => {
  if (states.length === 0) return "absent";
  return states.includes("running") ? "running" : "stopped";
};

export const inspectDevcontainer = async (name: string) =>
  stateOf(
    await dockerLines(
      "ps",
      "-a",
      "--filter",
      `label=${nameLabel}=${name}`,
      "--format",
      "{{.State}}",
    ),
  );

// `isActive`: a container of the sandbox (the main one, a service, the proxy) has processes.
export type DevcontainerStatus = { main: ContainerState; isActive: boolean };

// `paused` and `restarting` keep processes.
const inactiveStates = new Set(["created", "exited", "dead"]);

// One call without a filter: a filter cannot match any one of three labels.
export const inspectDevcontainers = async () => {
  const labels = [nameLabel, projectLabel, networkLabel];
  const format = [...labels.map((label) => `{{.Label "${label}"}}`), "{{.State}}"].join("\t");
  const lines = await dockerLines("ps", "-a", "--format", format);
  const found = new Map<string, { main: string[]; isActive: boolean }>();
  for (const line of lines) {
    const [main = "", project = "", network = "", state = ""] = line.split("\t");
    for (const name of new Set([main, project, network].filter(Boolean))) {
      const status = found.get(name) ?? { main: [], isActive: false };
      if (name === main) status.main.push(state);
      if (!inactiveStates.has(state)) status.isActive = true;
      found.set(name, status);
    }
  }
  return new Map(
    [...found].map(([name, { main, isActive }]): [string, DevcontainerStatus] => [
      name,
      { main: stateOf(main), isActive },
    ]),
  );
};

const inspectRunContainer = async (name: string, workspaceFolder: string) => {
  const [id] = await dockerLines("ps", "-q", "--filter", `label=${nameLabel}=${name}`);
  if (!id) return undefined;
  const format =
    '{"name":{{json .Name}},"mounts":{{json .Mounts}},"user":{{json .Config.User}},"metadata":{{json (index .Config.Labels "devcontainer.metadata")}}}';
  // `up` binds the real path of the workspace folder.
  const [inspected, source] = await Promise.all([
    docker(["inspect", "--format", format, id], shortCall),
    realpath(workspaceFolder),
  ]);
  const {
    name: containerName,
    mounts,
    user,
    metadata,
  } = JSON.parse(inspected) as {
    name: string;
    mounts: { Source: string; Destination: string }[];
    user: string;
    metadata: string | null;
  };
  const workspace = mounts.find((mount) => mount.Source === source);
  return { id, containerName: containerName.slice(1), workspace, user, metadata };
};

export const inspectAttach = async (name: string, workspaceFolder: string) => {
  const container = await inspectRunContainer(name, workspaceFolder);
  return (
    container?.workspace && {
      containerName: container.containerName,
      containerFolder: container.workspace.Destination,
    }
  );
};

export const inspectContainerProcesses = async (name: string, workspaceFolder: string) => {
  const container = await inspectRunContainer(name, workspaceFolder);
  if (!container?.workspace) throw new Error("The container of the run does not run");
  const { id, user, metadata, workspace } = container;
  return containerProcesses(id, remoteUserOf(metadata, user), workspace.Destination);
};

const restartStop = async (name: string) => {
  const ids = await dockerLines("ps", "-q", "--filter", `label=${nameLabel}=${name}`);
  // The agent user gets TERM first: an agent CLI saves its session cost at exit.
  for (const id of ids) {
    // A container without agents has no agent user.
    await docker(["exec", "--user", agentUser, id, "sh", "-c", stopAgentUser], shortCall).catch(
      () => {},
    );
  }
  // All services stop: a service that uses the network of the container loses it at a restart.
  await stopDevcontainer(name);
};

// A crash during an agent turn leaves files of the agent user, which the host cannot remove.
export const reclaimWorkspace = async (workspaceFolder: string, signal?: AbortSignal) => {
  const uid = String(process.getuid!());
  const find = [workspaceFolder, "!", "-user", uid, "-print", "-quit"];
  const { stdout } = await output("find", find, { signal });
  if (stdout === "") return;
  await docker(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "root",
      "--volume",
      `${workspaceFolder}:/workspace`,
      "--entrypoint",
      "chown",
      // The proxy image is local, also when no container of the run is left.
      proxyImage,
      "-Rh",
      hostOwner(),
      "/workspace",
    ],
    { signal },
  );
};

// An abort stops `up`, then removes a new container or stops a kept one.
export const upDevcontainer = async (
  options: DevcontainerOptions,
  signal?: AbortSignal,
): Promise<Devcontainer> => {
  const state = await inspectDevcontainer(options.name);
  // An earlier process could read the setup token of `up`, and `up` cannot use a paused container.
  if (state !== "absent") await restartStop(options.name);
  // The lifecycle commands of `up` write the workspace as the remote user.
  await reclaimWorkspace(options.workspaceFolder, signal);
  try {
    return await bringUp(options, signal);
  } catch (error) {
    // The error of `up` is the one to report; the sandbox pass stops a kept sandbox again.
    await (state === "absent" ? deleteDevcontainer : stopDevcontainer)(options.name).catch(
      () => {},
    );
    throw error;
  }
};

const labelsOf = (name: string, labels = [nameLabel, projectLabel, networkLabel]) =>
  labels.map((label) => `${label}=${name}`);

const findContainers = async (name: string, labels?: string[]) => {
  const ids = await Promise.all(
    labelsOf(name, labels).map((label) => dockerLines("ps", "-aq", "--filter", `label=${label}`)),
  );
  return [...new Set(ids.flat())];
};

const deleteLabelled = async (kind: "network" | "volume", name: string) => {
  const found = await Promise.all(
    labelsOf(name).map((label) => dockerLines(kind, "ls", "-q", "--filter", `label=${label}`)),
  );
  const names = [...new Set(found.flat())];
  if (names.length > 0) await docker([kind, "rm", ...names], shortCall);
};

// Not the network label: that also gives the proxy.
const findRunContainers = (name: string) => findContainers(name, [nameLabel, projectLabel]);

export const stopDevcontainer = async (name: string) => {
  const ids = await findContainers(name);
  // A fixed grace period: a `stop_grace_period` of the repo could exceed the time limit.
  if (ids.length > 0) await docker(["stop", "--timeout", "10", ...ids], shortCall);
  // A network that stays costs an address pool, and `up` uses it again.
  await deleteLabelled("network", name).catch(() => {});
};

export const deleteDevcontainer = async (name: string) => {
  const ids = await findContainers(name);
  if (ids.length > 0) await docker(["rm", "--force", "--volumes", ...ids], shortCall);
  await Promise.all([deleteLabelled("network", name), deleteLabelled("volume", name)]);
};

// `docker start` fails on a removed network id; a connect replaces the stale entry with its aliases.
const reconnectStaleNetworks = async (containers: string[]) => {
  for (const container of containers) {
    const networks = JSON.parse(
      await docker(
        ["inspect", "--format", "{{json .NetworkSettings.Networks}}", container],
        shortCall,
      ),
    ) as Record<string, { NetworkID: string; Aliases: string[] | null }>;
    for (const [network, { NetworkID, Aliases }] of Object.entries(networks)) {
      const [current] = await dockerLines("network", "inspect", "--format", "{{.Id}}", network);
      if (current === NetworkID) continue;
      const aliases = (Aliases ?? []).flatMap((alias) => ["--alias", alias]);
      await docker(["network", "connect", ...aliases, network, container], shortCall);
    }
  }
};

type RestoreNetworksOptions = { composeFiles: string[] | undefined; env: NodeJS.ProcessEnv };

const restoreNetworks = async (
  name: string,
  { composeFiles, env }: RestoreNetworksOptions,
  signal?: AbortSignal,
) => {
  const kept = await findRunContainers(name);
  if (kept.length === 0) return;
  if (composeFiles) {
    const files = composeFiles.flatMap((file) => ["-f", file]);
    const services = await dockerLines(
      "ps",
      "-a",
      "--filter",
      `label=${projectLabel}=${name}`,
      "--format",
      `{{.Label "${serviceLabel}"}}`,
    );
    // Only the kept services: `up` of the CLI can skip another service, which has no image.
    await docker(
      [
        "compose",
        ...files,
        "up",
        "--no-start",
        "--no-recreate",
        "--no-build",
        "--no-deps",
        ...new Set(services),
      ],
      { env, signal },
    );
  }
  await reconnectStaleNetworks(kept);
};

// `anyProcess` skips zombies: the PID 1 of a container often does not remove them.
const stopGroup = `
anyProcess() {
  match=$1
  for f in /proc/[0-9]*/stat; do
    read -r s 2>/dev/null < "$f" || continue
    pid=\${s%% *}
    set -- \${s##*) }
    [ "$1" != Z ] && "$match" "$f" "$pid" "$@" && return 0
  done
  return 1
}
inGroup() { [ "$5" = "$pgid" ]; }
alive() { kill -0 -"$pgid" 2>/dev/null && anyProcess inGroup; }
poll() {
  i=0; while "$@" && [ $i -lt 20 ]; do sleep 0.1; i=$((i + 1)); done
}
stop() {
  [ "$pgid" -gt 1 ] 2>/dev/null || return 0
  kill -TERM -"$pgid" 2>/dev/null || return 0
  poll alive
  kill -KILL -"$pgid" 2>/dev/null
  poll alive
}
`;

// As the agent user, `kill -1` reaches all processes of that user except this shell.
const stopUser = `
ownOther() { [ "$2" != $$ ] && [ -O "$1" ]; }
others() { anyProcess ownOther; }
stopUser() {
  kill -TERM -1 2>/dev/null
  poll others
  kill -KILL -1 2>/dev/null
  poll others
}
`;

const stopAgentUser = `${stopGroup}${stopUser}
stopUser
`;

// The script stops the processes that the command leaves in its group.
const runInGroup = `${stopGroup}
set -C
true 2>/dev/null > "$0" || exit 143
set +C
exec 3<&0
setsid "$@" <&3 3<&- &
pgid=$!
exec 3<&-
echo "$pgid" > "$0"
wait "$pgid" 2>/dev/null
code=$?
stop
rm -f "$0"
exit "$code"
`;

// The first to create the pid file wins: the command, or an abort that keeps it from starting.
const stopRun = `${stopGroup}
set -C
true 2>/dev/null > "$0" && exit 0
poll [ ! -s "$0" ]
read -r pgid < "$0"
[ "$pgid" -gt 1 ] 2>/dev/null || exit 0
# Before its setsid, the command has no group.
kill -TERM "$pgid" 2>/dev/null
stop
`;

// A process of the agent can outlive its turns, so each folder is locked before its check.
const lockGitFolder = `
cd "$2"
chown -h "$1" .
chmod go-w .
if [ -L .git ] || [ ! -d .git ]; then echo ".git is not a folder" >&2; exit 1; fi
chown -h "$1" .git
chmod go-w .git
`;

// A `.git/commondir` file makes git read the config of another folder.
const writeGitConfig = `
chmod -R go-w .git
rm -rf .git/config .git/commondir
printf %s "$3" > .git/config
chown "$1" .git/config
`;

// Only when no process of the agent runs: a stopped git call leaves its locks.
const deleteGitLocks = `
rm -rf .git/*.lock
for folder in refs logs reftable; do
  [ -L ".git/$folder" ] || [ ! -d ".git/$folder" ] || find ".git/$folder" -name '*.lock' ! -type d -exec rm -f {} +
done
`;

const restoreGitConfigScript = `set -e${lockGitFolder}${writeGitConfig}${deleteGitLocks}`;

// `kill -1` as the agent user has stopped its processes; a fork cannot escape that kill.
const checkAgentStopped = `
agentUid=$(id -u ${agentUser} 2>/dev/null) || agentUid=
ofAgent() {
  while read -r key uid _; do
    [ "$key" = Uid: ] && { [ "$uid" = "$agentUid" ]; return; }
  done 2>/dev/null < "/proc/$2/status"
  return 1
}
if [ -n "$agentUid" ]; then
  poll anyProcess ofAgent
  if anyProcess ofAgent; then echo "a process of the agent did not stop" >&2; exit 1; fi
fi
`;

// `find` skips links and changes only the files that give write access to group or others.
const giveToHostScript = `${stopGroup}${checkAgentStopped}set -e${lockGitFolder}chown -Rh "$1" .
find . ! -type l -perm /022 -exec chmod go-w {} +${writeGitConfig}${deleteGitLocks}`;

const agentIdScript = `set -e; uid=$(id -u ${agentUser}); gid=$(id -g ${agentUser}); printf %s:%s "$uid" "$gid"`;

type DevcontainerSandboxOptions = {
  environment: Record<string, string>;
  policy: EgressPolicy;
  runnerGitConfig: string;
  innerDocker?: InnerDocker;
};

export class DevcontainerSandbox implements Sandbox {
  private agentIdOnce?: Promise<string>;

  constructor(
    private readonly container: Devcontainer,
    private readonly options: DevcontainerSandboxOptions,
  ) {}

  get workspaceFolder() {
    return this.container.remoteWorkspaceFolder;
  }

  // `docker exec` gives the exit code of a failed command when the container does not run.
  async exec(command: string[], options: ExecOptions = {}) {
    return execWithin(command, options, async (within) => {
      const result = await collectOutput(await this.start(command, within), within);
      if (result.exitCode !== 0 && !(await this.isRunning(within.signal))) {
        const reason = result.stderr.trim().split("\n").at(-1);
        throw new Error(`The container ${this.container.containerId} does not run: ${reason}`);
      }
      return result;
    });
  }

  async spawn(command: string[], options: SpawnOptions) {
    return toSandboxProcess(await this.start(command, options));
  }

  // Only for setup, the workspace owner and the git config restore; it keeps the same environment.
  async execAsRoot(command: string[], options: ExecOptions = {}) {
    return execWithin(command, options, async (within) =>
      collectOutput(await this.start(command, within, "root"), within),
    );
  }

  async assignWorkspace(owner: WorkspaceOwner) {
    const action = `give the workspace to the ${owner} user`;
    if (owner === "agent") {
      const command = ["chown", "-Rh", `${agentUser}:${agentUser}`, this.workspaceFolder];
      return this.changeWorkspace(command, action);
    }
    // No process of the agent may keep a file or a lock during the give-back.
    await this.stopAgentUser().catch((error: unknown) => {
      throw this.failed(action, errorMessage(error));
    });
    await this.changeWorkspace(this.restoreCommand(giveToHostScript), action);
  }

  // After a crash during a turn, `.git/config` is still the agent's.
  async restoreGitConfig(signal?: AbortSignal) {
    await this.changeWorkspace(
      this.restoreCommand(restoreGitConfigScript),
      "restore the git config",
      signal,
    );
  }

  private failed(action: string, reason: string) {
    return new Error(`Halinka could not ${action}: ${reason}`);
  }

  private async changeWorkspace(command: string[], action: string, signal?: AbortSignal) {
    const { exitCode, stderr } = await this.execAsRoot(command, {
      timeoutMs: sandboxGitTimeoutMs,
      signal,
    }).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      throw this.failed(action, errorMessage(error));
    });
    if (exitCode !== 0) throw this.failed(action, stderr.trim());
  }

  private restoreCommand(script: string) {
    const { workspaceFolder } = this;
    const { runnerGitConfig } = this.options;
    return ["sh", "-c", script, "restore", hostOwner(), workspaceFolder, runnerGitConfig];
  }

  private async userOf(as: "root" | SandboxUser) {
    if (as === "agent") return this.agentId();
    return as === "root" ? "root" : this.container.remoteUser;
  }

  // Sysbox finds no user by name that was created after the start of the container.
  private agentId() {
    this.agentIdOnce ??= docker(
      rootExec(this.container.containerId, "sh", "-c", agentIdScript),
      shortCall,
    ).catch((error: unknown) => {
      this.agentIdOnce = undefined;
      throw error;
    });
    return this.agentIdOnce;
  }

  private async stopAgentUser() {
    const { containerId } = this.container;
    const user = await this.agentId();
    await docker(["exec", "--user", user, containerId, "sh", "-c", stopAgentUser], shortCall);
  }

  // After the command and its wrapper end, `kill -1` as the agent user stops what they left.
  private async ended(release: () => Promise<void>, as: "root" | SandboxUser) {
    try {
      await release();
    } finally {
      if (as === "agent") {
        await this.stopAgentUser().catch(async (error: unknown) => {
          if (await this.isRunning()) throw error;
        });
      }
    }
  }

  private async isRunning(signal?: AbortSignal) {
    const state = await output(
      "docker",
      ["container", "inspect", "--format", "{{.State.Running}}", this.container.containerId],
      { signal, timeoutMs: sandboxCallTimeoutMs },
    );
    return state.stdout.trim() === "true";
  }

  private async start(
    command: string[],
    {
      env = {},
      network = [],
      credentialNames,
      user = "remote",
      isRepoCode = false,
      signal,
    }: Partial<SpawnOptions>,
    as: "root" | SandboxUser = user,
  ): Promise<StartedProcess> {
    const { file, args } = checkedCommand(command, signal);
    const { containerId, noProxy } = this.container;
    // Without a token the command reaches no host.
    const isTokenNeeded =
      network === true || network.length > 0 || Boolean(credentialNames?.length);
    const { policy, innerDocker } = this.options;
    // Started together, the two grants share one write of the policy.
    const [granted, held, execUser] = await Promise.allSettled([
      isTokenNeeded ? policy.grant({ hosts: network, credentialNames }) : undefined,
      isRepoCode && as === "remote" ? innerDocker?.hold(network) : undefined,
      this.userOf(as),
    ]);
    const token = granted.status === "fulfilled" ? granted.value : undefined;
    const releaseDocker = held.status === "fulfilled" ? held.value : undefined;
    const release = async () => {
      await Promise.all([token && policy.revoke(token), releaseDocker?.()]);
    };
    const failed = [granted, held, execUser].find((result) => result.status === "rejected");
    // No await from here to the abort listener: an abort between them would be lost.
    if (failed || execUser.status === "rejected" || signal?.aborted) {
      await release();
      throw failed ? failed.reason : abortError();
    }
    const environment = splitEnvironment({
      ...this.options.environment,
      ...(as === "agent" && agentEnvironment),
      ...env,
      ...(token ? proxyEnvironment(token, noProxy) : {}),
    });
    const pidFile = `/tmp/halinka-${randomUUID()}.pid`;
    const exec = [
      "--interactive",
      "--user",
      execUser.value,
      "--workdir",
      this.workspaceFolder,
      ...environment.args,
      containerId,
      "sh",
      "-c",
      runInGroup,
      pidFile,
      file,
      ...args,
    ];
    const child = spawnWithEnvFile(exec, environment.file, [
      "pipe",
      "pipe",
      "pipe",
    ]) as ChildProcessWithoutNullStreams;
    // A failed revoke leaves the token granted, so `stopped` rejects.
    const stopped = new Promise<void>((resolve) =>
      child.on("close", () => resolve(this.ended(release, as))),
    );
    // Killing the `docker exec` client does not stop the command in the container.
    const stopInContainer = () => {
      const stop = rootExec(containerId, "sh", "-c", stopRun, pidFile);
      void output("docker", stop, shortCall)
        .catch(() => {})
        .finally(() => {
          child.kill("SIGKILL");
          child.stdout.destroy();
          child.stderr.destroy();
        });
    };
    signal?.addEventListener("abort", stopInContainer, { once: true });
    child.on("close", () => signal?.removeEventListener("abort", stopInContainer));
    return { child, stopped };
  }
}

// Only `devcontainer exec` applies the shell profile, `remoteEnv` and the Features.
export const attachDevcontainer = async (
  container: Devcontainer,
  { policy, runnerGitConfig }: Omit<DevcontainerSandboxOptions, "environment" | "innerDocker">,
  signal?: AbortSignal,
) => {
  const { exitCode, stdout, stderr } = await withCliEnvironment(undefined, (env) =>
    output(
      process.execPath,
      [cli, "exec", "--container-id", container.containerId, "--", "cat", "/proc/self/environ"],
      { env, signal },
    ),
  );
  if (exitCode !== 0) {
    throw new Error(stderr.trim().split("\n").at(-1) || "devcontainer exec failed");
  }
  const environment = stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.split(/=(.*)/s, 2));
  const { containerId, remoteUser, noProxy, isDockerInside } = container;
  const innerDocker = isDockerInside
    ? await InnerDocker.start({ containerId, remoteUser, noProxy, policy, signal })
    : undefined;
  return new DevcontainerSandbox(container, {
    environment: Object.fromEntries(environment),
    policy,
    runnerGitConfig,
    innerDocker,
  });
};
