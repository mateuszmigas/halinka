import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { agentUser } from "./docker";
import { proxyImage } from "./runNetwork";

export type ContainerProcesses = {
  run: (command: string, args?: string[]) => ChildProcessWithoutNullStreams;
  connect: (port: number) => ChildProcessWithoutNullStreams;
};

type Metadata = { remoteUser?: string; containerUser?: string };

// The devcontainer CLI writes the merged configuration in this label: the last value wins.
export const remoteUserOf = (label: string | null, imageUser: string) => {
  const metadata = label ? (JSON.parse(label) as Metadata | Metadata[]) : [];
  const entries = Array.isArray(metadata) ? metadata : [metadata];
  const last = (key: keyof Metadata) => entries.findLast((entry) => entry[key])?.[key];
  const user = last("remoteUser") ?? last("containerUser") ?? (imageUser.split(":")[0] || "root");
  if (user === agentUser) throw new Error("The remote user of the container is the agent user");
  return user;
};

// The bridge brings its own `nc`: the image of the container can have none.
const bridgeArguments = (containerId: string, port: number) => [
  "run",
  "--rm",
  "--interactive",
  "--init",
  `--network=container:${containerId}`,
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  "--user=65534",
  "--memory=64m",
  "--pids-limit=16",
  "--entrypoint=nc",
  proxyImage,
  "127.0.0.1",
  String(port),
];

export const containerProcesses = (
  containerId: string,
  user: string,
  folder: string,
): ContainerProcesses => {
  const exec = ["exec", "--interactive", `--user=${user}`, `--workdir=${folder}`, containerId];
  return {
    run: (command, args = []) => spawn("docker", [...exec, "sh", "-c", command, "sh", ...args]),
    connect: (port) => spawn("docker", bridgeArguments(containerId, port)),
  };
};
