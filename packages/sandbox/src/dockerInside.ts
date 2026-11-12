import { randomUUID } from "node:crypto";
import { BlockList } from "node:net";

import { abortError } from "@halinka/utils/errors";
import { poll } from "@halinka/utils/poll";

import { docker, output, rootExec, shortCall, spawnWithEnvFile, splitEnvironment } from "./docker";
import { type EgressPolicy, type GrantOptions, proxyEnvironment } from "./runNetwork";

// Docker hosts do not take addresses from 100.64.0.0/10 by default.
const innerRange = { base: "100.64.0.0", prefix: 15 };
const innerBridge = "100.64.0.1/24";
const innerPool = "base=100.65.0.0/16,size=24";

const socket = "unix:///var/run/docker.sock";
const logFile = "/var/log/halinka-dockerd.log";
const readyTimeoutMs = 60_000;

// Halinka starts the daemon, so that only the daemon gets its proxy token.
const checkScript = `
for command in dockerd docker; do
  command -v "$command" >/dev/null || { echo "The devcontainer has no $command, which setup.docker needs. Add Docker Engine to its image." >&2; exit 1; }
done
if docker --host ${socket} version >/dev/null 2>&1; then
  echo "A Docker daemon already runs in the devcontainer. Remove its start from the image: Halinka starts it." >&2; exit 1
fi
id -g "$1"
`;

// A stop of the container leaves the pid file, and its PID can name another process after the start.
const startScript = `umask 077; rm -f /var/run/docker.pid; exec dockerd --host ${socket} --group "$1" --bip ${innerBridge} --default-address-pool ${innerPool} >>${logFile} 2>&1`;

// A container that a command started could write the workspace in the next turn.
const deleteContainersScript = `
ids=$(docker --host ${socket} ps -aq) || exit 1
[ -z "$ids" ] || docker --host ${socket} rm --force $ids >/dev/null
`;

export type AttachedNetwork = { IPAddress: string; IPPrefixLen: number };

// An inner network with the subnet of an outer one hides the route to the proxy.
export const innerRangeProblem = (networks: Record<string, AttachedNetwork>) => {
  const inner = new BlockList();
  inner.addSubnet(innerRange.base, innerRange.prefix);
  for (const [name, { IPAddress, IPPrefixLen }] of Object.entries(networks)) {
    if (!IPAddress) continue;
    const outer = new BlockList();
    outer.addSubnet(IPAddress, IPPrefixLen);
    if (inner.check(IPAddress) || outer.check(innerRange.base)) {
      return `The network ${name} (${IPAddress}/${IPPrefixLen}) of the container overlaps ${innerRange.base}/${innerRange.prefix}, which Docker in the container uses. Change the address pools of the Docker host.`;
    }
  }
  return undefined;
};

const requireFreeInnerRange = async (containerId: string) => {
  const format = ["inspect", "--format", "{{json .NetworkSettings.Networks}}", containerId];
  const problem = innerRangeProblem(JSON.parse(await docker(format, shortCall)));
  if (problem) throw new Error(problem);
};

const isReady = async (containerId: string) =>
  (await output("docker", rootExec(containerId, "docker", "--host", socket, "version"), shortCall))
    .exitCode === 0;

const waitUntilReady = (containerId: string, signal?: AbortSignal) => {
  const deadline = Date.now() + readyTimeoutMs;
  return poll(async () => {
    if (await isReady(containerId)) return true;
    if (signal?.aborted) throw abortError();
    if (Date.now() < deadline) return undefined;
    const log = await output(
      "docker",
      rootExec(containerId, "tail", "-n", "5", logFile),
      shortCall,
    );
    throw new Error(
      `Docker in the container did not start in ${readyTimeoutMs / 1000} s: ${log.stdout.trim()}`,
    );
  }, 500);
};

const startDetached = (containerId: string, args: string[], envFile: string) =>
  new Promise<void>((resolve, reject) => {
    const exec = ["--detach", "--user", "root", containerId, ...args];
    const child = spawnWithEnvFile(exec, envFile, ["ignore", "ignore", "pipe"]);
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(stderr.trim() || "docker exec failed")),
    );
  });

type StartOptions = {
  containerId: string;
  remoteUser: string;
  noProxy: string[];
  policy: EgressPolicy;
  signal?: AbortSignal;
};

// The daemon in the container: its token reaches hosts only while a command of the repo runs.
export class InnerDocker {
  // the hosts of each running command of the repo
  private readonly held = new Map<string, GrantOptions["hosts"]>();
  // the hosts of the last write; none at the start
  private written = "[]";
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly containerId: string,
    private readonly policy: EgressPolicy,
    private readonly token: string,
  ) {}

  // Only the remote user gets the socket: access to the socket equals root in the container.
  static async start({ containerId, remoteUser, noProxy, policy, signal }: StartOptions) {
    const [gid] = await Promise.all([
      docker(rootExec(containerId, "sh", "-c", checkScript, "check", remoteUser), shortCall),
      requireFreeInnerRange(containerId),
    ]);
    const token = randomUUID();
    const { file } = splitEnvironment(proxyEnvironment(token, noProxy));
    await startDetached(containerId, ["sh", "-c", startScript, "start", gid.trim()], file);
    await waitUntilReady(containerId, signal);
    return new InnerDocker(containerId, policy, token);
  }

  // The returned release ends the hosts of the command; the last one removes the inner containers.
  async hold(hosts: GrantOptions["hosts"]) {
    const id = randomUUID();
    this.held.set(id, hosts);
    await this.write().catch((error: unknown) => {
      this.held.delete(id);
      throw error;
    });
    return async () => {
      this.held.delete(id);
      await Promise.all([this.write(), this.held.size === 0 && this.deleteContainers()]);
    };
  }

  // A call for the hosts of a running write waits for that write.
  private write() {
    const all = [...this.held.values()];
    const lists = all.filter((hosts) => hosts !== true);
    const hosts = lists.length < all.length ? true : [...new Set(lists.flat())];
    const key = JSON.stringify(hosts);
    if (key === this.written) return this.writing;
    this.written = key;
    const grant = hosts === true || hosts.length > 0;
    this.writing = (
      grant ? this.policy.grant({ hosts }, this.token) : this.policy.revoke(this.token)
    ).then(
      () => {},
      (error: unknown) => {
        if (this.written === key) this.written = "";
        throw error;
      },
    );
    return this.writing;
  }

  private async deleteContainers() {
    const command = rootExec(this.containerId, "sh", "-c", deleteContainersScript);
    await docker(command, shortCall).catch(async (error: unknown) => {
      const state = await output(
        "docker",
        ["container", "inspect", "--format", "{{.State.Running}}", this.containerId],
        shortCall,
      );
      if (state.stdout.trim() === "true") throw error;
    });
  }
}
