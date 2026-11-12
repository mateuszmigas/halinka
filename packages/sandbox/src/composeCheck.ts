import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { isRealPathInside, pathExists } from "@halinka/utils/fs";
import { isRecord } from "@halinka/utils/isRecord";
import { parse } from "yaml";

import {
  allowedCapabilities,
  allowedPropagations,
  isReservedLabel,
  isString,
  movedBindSource,
  Problems,
  reachesHost,
  type RealFolders,
  text,
} from "./checkRules";

type Document = Record<string, unknown>;

const topLevelKeys = new Set(["name", "services", "volumes", "networks", "secrets", "configs"]);

const serviceKeys = new Set([
  "image",
  "build",
  "command",
  "entrypoint",
  "environment",
  "env_file",
  "working_dir",
  "user",
  "volumes",
  "depends_on",
  "healthcheck",
  "expose",
  "networks",
  "labels",
  "shm_size",
  "tmpfs",
  "ulimits",
  "init",
  "restart",
  "stop_signal",
  "stop_grace_period",
  "hostname",
  "domainname",
  "platform",
  "tty",
  "stdin_open",
  "cap_add",
  "cap_drop",
  "security_opt",
  "extra_hosts",
  "links",
  "network_mode",
  "ipc",
  "volumes_from",
  "mem_limit",
  "mem_reservation",
  "cpus",
  "pids_limit",
  "deploy",
  "profiles",
  "read_only",
  "pull_policy",
  "secrets",
  "configs",
]);

const servicePatterns: Record<string, RegExp> = {
  // The CLI writes the image into its compose file without escaping it.
  image: /^[\w./:@-]+$/,
  network_mode: /^(none|service:.+)$/,
  ipc: /^(private|shareable|service:.+)$/,
};

const buildKeys = new Set(["context", "dockerfile", "args", "target", "dockerfile_inline"]);
const deployKeys = new Set(["resources", "placement"]);
const resourcesKeys = new Set(["limits", "reservations"]);
const resourceKeys = new Set(["cpus", "memory", "pids"]);
const networkAttachmentKeys = new Set(["aliases"]);
const noKeys = new Set<string>();

const volumeKeys: Record<string, Set<string>> = {
  bind: new Set(["type", "source", "target", "read_only", "consistency", "bind"]),
  volume: new Set(["type", "source", "target", "read_only", "consistency", "volume"]),
  tmpfs: new Set(["type", "target", "tmpfs"]),
};

const volumeOptionKeys: Record<string, Set<string>> = {
  bind: new Set(["propagation", "create_host_path"]),
  volume: new Set(["nocopy", "subpath"]),
  tmpfs: new Set(["size", "mode"]),
};

const projectResources: Record<string, { keys: Set<string>; driver?: string }> = {
  volumes: { keys: new Set(["name", "driver", "labels"]), driver: "local" },
  networks: {
    keys: new Set(["name", "driver", "labels", "internal", "ipam", "enable_ipv6"]),
    driver: "bridge",
  },
  secrets: { keys: new Set(["name", "file", "environment", "content"]) },
  configs: { keys: new Set(["name", "file", "environment", "content"]) },
};

// The services and networks that Halinka adds to a project use this prefix.
const isReservedName = (name: string) => name.startsWith("halinka");

// `docker compose config` hides `include`, `extends.file` and unused names, so check the files.
export const checkComposeSources = async (files: string[], treeFolder: string) => {
  const problems: string[] = [];
  const [first] = files;
  // Compose reads `.env` next to the first file; a symlink there can read a host file.
  const dotenv = first && join(dirname(first), ".env");
  if (dotenv && (await pathExists(dotenv)) && !(await isRealPathInside(dotenv, treeFolder))) {
    problems.push(`${dotenv} is outside the repository`);
  }
  for (const file of files) {
    // Merge keys can carry an `extends.file` into a service.
    const document: unknown = parse(await readFile(file, "utf8"), { merge: true });
    if (!isRecord(document)) continue;
    if (document.include !== undefined) problems.push(`${file}: include is not allowed`);
    for (const kind of ["services", ...Object.keys(projectResources)]) {
      const names = isRecord(document[kind]) ? Object.keys(document[kind]) : [];
      for (const name of names.filter(isReservedName)) {
        problems.push(`${file}: ${kind}.${name}: the name is reserved`);
      }
    }
    const services = isRecord(document.services) ? document.services : {};
    for (const [name, service] of Object.entries(services)) {
      const extended = isRecord(service) ? service.extends : undefined;
      if (isRecord(extended) && extended.file !== undefined) {
        problems.push(`${file}: services.${name}.extends.file is not allowed`);
      }
    }
  }
  return problems;
};

export const checkCompose = async (document: Document, folders: RealFolders, project: string) => {
  const problems = new Problems();
  const checkTreeFile = (where: string, path: unknown) =>
    problems.checkInside(where, path, { folder: folders.treeFolder, folderName: "repository" });

  const resources = Object.fromEntries(
    Object.keys(projectResources).map((kind) => [
      kind,
      problems.recordOf(`compose: ${kind}`, document[kind]),
    ]),
  );

  const checkVolume = (where: string, value: unknown) => {
    const type = isRecord(value) ? text(value.type) : "";
    const allowed = volumeKeys[type];
    if (!allowed) {
      problems.add(`${where}: type ${type} is not allowed`);
      return;
    }
    const volume = problems.keysOf(where, value, allowed);
    const options = problems.keysOf(`${where}: ${type}`, volume[type], volumeOptionKeys[type]!);
    if (type === "bind") {
      if (
        options.propagation !== undefined &&
        !allowedPropagations.has(text(options.propagation))
      ) {
        problems.add(`${where}: propagation ${text(options.propagation)} is not allowed`);
      }
      const source = isString(volume.source)
        ? (movedBindSource(volume.source, folders) ?? volume.source)
        : undefined;
      if (source)
        problems.checkInside(where, source, {
          folder: folders.workspaceFolder,
          folderName: "workspace",
        });
      else problems.add(`${where}: a bind needs a source`);
    }
    if (
      type === "volume" &&
      volume.source !== undefined &&
      !Object.hasOwn(resources.volumes!, text(volume.source))
    ) {
      problems.add(`${where}: ${text(volume.source)} is not a volume of the project`);
    }
  };

  const checkBuild = (where: string, value: unknown) => {
    const { context, dockerfile } = problems.keysOf(where, value, buildKeys);
    if (context !== undefined) checkTreeFile(`${where}.context`, context);
    if (dockerfile !== undefined && isString(context)) {
      checkTreeFile(`${where}.dockerfile`, resolve(context, text(dockerfile)));
    }
  };

  const checkDeploy = (where: string, value: unknown) => {
    const deploy = problems.keysOf(where, value, deployKeys);
    const limits = problems.keysOf(`${where}.resources`, deploy.resources, resourcesKeys);
    for (const kind of resourcesKeys) {
      problems.keysOf(`${where}.resources.${kind}`, limits[kind], resourceKeys);
    }
    problems.keysOf(`${where}.placement`, deploy.placement, noKeys);
  };

  const checkLabels = (where: string, labels: unknown) => {
    for (const label of Object.keys(problems.recordOf(`${where}: labels`, labels))) {
      if (isReservedLabel(label)) problems.add(`${where}: label ${label} is reserved`);
    }
  };

  const checkService = (name: string, value: unknown) => {
    const where = `compose service ${name}`;
    const service = problems.keysOf(where, value, serviceKeys);
    for (const [key, pattern] of Object.entries(servicePatterns)) {
      problems.matches(`${where}: ${key}`, service[key], pattern);
    }
    // Compose tags the build with `image` on the shared daemon.
    if (service.build !== undefined && service.image !== undefined) {
      problems.add(`${where}: image is not allowed with build`);
    }
    checkBuild(`${where}: build`, service.build);
    for (const file of problems.listOf(`${where}: env_file`, service.env_file)) {
      checkTreeFile(`${where}: env_file`, isRecord(file) ? file.path : file);
    }
    problems.valuesOf(`${where}: cap_add`, service.cap_add, (value) =>
      allowedCapabilities.has(value),
    );
    // A security option can disable seccomp or AppArmor.
    problems.valuesOf(`${where}: security_opt`, service.security_opt, () => false);
    problems.valuesOf(
      `${where}: extra_hosts`,
      service.extra_hosts,
      (host) => !reachesHost(host) && !isReservedName(host.split(/[=:]/)[0]!),
    );
    // A name with the prefix could answer for the egress proxy.
    problems.valuesOf(
      `${where}: links`,
      service.links,
      (link) => !isReservedName(link.split(":").at(-1)!),
    );
    problems.valuesOf(
      `${where}: volumes_from`,
      service.volumes_from,
      (source) => !source.startsWith("container:"),
    );
    checkLabels(where, service.labels);
    for (const [network, attachment] of Object.entries(
      problems.recordOf(`${where}: networks`, service.networks),
    )) {
      if (!Object.hasOwn(resources.networks!, network)) {
        problems.add(`${where}: network ${network} is not of the project`);
      }
      const { aliases } = problems.keysOf(
        `${where}: networks.${network}`,
        attachment,
        networkAttachmentKeys,
      );
      problems.valuesOf(
        `${where}: networks.${network}.aliases`,
        aliases,
        (alias) => !isReservedName(alias),
      );
    }
    checkDeploy(`${where}: deploy`, service.deploy);
    problems
      .listOf(`${where}: volumes`, service.volumes)
      .forEach((volume, index) => checkVolume(`${where}: volumes.${index}`, volume));
  };

  for (const key of Object.keys(document)) {
    if (!topLevelKeys.has(key) && !key.startsWith("x-"))
      problems.add(`compose: ${key} is not allowed`);
  }
  for (const [name, service] of Object.entries(
    problems.recordOf("compose: services", document.services),
  )) {
    checkService(name, service);
  }
  for (const [kind, { keys, driver }] of Object.entries(projectResources)) {
    for (const [key, value] of Object.entries(resources[kind]!)) {
      const where = `compose ${kind}.${key}`;
      const resource = problems.keysOf(where, value, keys);
      if (resource.name !== `${project}_${key}`) {
        problems.add(`${where}: name ${text(resource.name)} is not allowed`);
      }
      if (resource.driver !== undefined && resource.driver !== driver) {
        problems.add(`${where}: driver ${text(resource.driver)} is not allowed`);
      }
      checkLabels(where, resource.labels);
      problems.keysOf(`${where}: ipam`, resource.ipam, noKeys);
      if (resource.file !== undefined) checkTreeFile(`${where}: file`, resource.file);
    }
  }
  return problems.all();
};
