import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createFileOnce, ensureFolder } from "@halinka/utils/fs";
import { halinkaHome } from "@halinka/utils/halinkaHome";
import { hashOf } from "@halinka/utils/hash";
import { SerialQueue } from "@halinka/utils/serialQueue";

import { docker, dockerLines, networkLabel, shortCall } from "./docker";
import { createProxyCertificate, type ProxyCertificate } from "./proxyCertificate";

export const proxyImage =
  "node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914";
const proxySource = fileURLToPath(new URL("./egressProxy.mjs", import.meta.url));
const proxyAlias = "halinka-proxy";
const proxyPort = 3128;
const maxProxyConnections = 512;
const proxyMemory = "256m";
const policyFolder = "/halinka/policy";

export const policyFile = `${policyFolder}/policy.json`;
// `mv` publishes the whole file, so the proxy never reads a part.
const writePolicyScript = `umask 077 && cat > ${policyFolder}/policy.new && mv ${policyFolder}/policy.new ${policyFile}`;

type CreateNetworkOptions = { isInternal: boolean };

// Only the proxy joins `egress`; `internal` has no route out.
export const runNetworksOf = (name: string) => ({
  internal: `${name}-internal`,
  egress: `${name}-egress`,
  proxy: `${name}-proxy`,
});

const exists = async (kind: "network" | "container", name: string) =>
  (
    await dockerLines(
      kind,
      "ls",
      ...(kind === "container" ? ["-a"] : []),
      "-q",
      "--filter",
      `name=^${name}$`,
    )
  ).length > 0;

// The host gets no address on an internal network, so the run cannot reach its services.
export const isolatedGateway = {
  "com.docker.network.bridge.gateway_mode_ipv4": "isolated",
};

const createNetwork = async (
  name: string,
  network: string,
  { isInternal }: CreateNetworkOptions,
) => {
  if (await exists("network", network)) return;
  const isolated = Object.entries(isolatedGateway).flatMap(([key, value]) => [
    "-o",
    `${key}=${value}`,
  ]);
  await docker(
    [
      "network",
      "create",
      ...(isInternal ? ["--internal", ...isolated] : []),
      "--label",
      `${networkLabel}=${name}`,
      network,
    ],
    shortCall,
  );
};

// Docker Desktop cannot mount a global npm folder, and npm can remove its npx cache during a run.
const copyProxyScript = async () => {
  const script = await readFile(proxySource, "utf8");
  const hash = hashOf(script).slice(0, 16);
  await ensureFolder(halinkaHome());
  // The name holds the content, so a new run never replaces the file of another run.
  const path = join(halinkaHome(), `egressProxy-${hash}.mjs`);
  await createFileOnce(path, script);
  return path;
};

export const startRunNetwork = async (name: string, signal?: AbortSignal) => {
  const { internal, egress, proxy } = runNetworksOf(name);
  await Promise.all([
    createNetwork(name, internal, { isInternal: true }),
    createNetwork(name, egress, { isInternal: false }),
  ]);
  // A new proxy for each `up`: an earlier runner can have made it with other arguments.
  if (await exists("container", proxy)) await docker(["rm", "--force", proxy], shortCall);
  const proxyScript = await copyProxyScript();
  // The create can pull the proxy image.
  await docker(
    [
      "create",
      "--name",
      proxy,
      "--label",
      `${networkLabel}=${name}`,
      "--network",
      egress,
      "--restart",
      "no",
      "--pids-limit",
      "256",
      "--memory",
      proxyMemory,
      "--memory-swap",
      proxyMemory,
      "--read-only",
      "--mount",
      `type=bind,src=${proxyScript},dst=/halinka/proxy.mjs,readonly`,
      // The policy holds the tokens: it never goes to the runner's disk.
      "--tmpfs",
      `${policyFolder}:mode=0700,size=1m`,
      "--entrypoint",
      "node",
      proxyImage,
      "/halinka/proxy.mjs",
      policyFile,
      String(proxyPort),
      proxyAlias,
      String(maxProxyConnections),
    ],
    { signal },
  );
  await docker(["network", "connect", "--alias", proxyAlias, internal, proxy], shortCall);
  await docker(["start", proxy], shortCall);
  return internal;
};

// The proxy name is not in NO_PROXY, so a route request carries the token.
export const proxyRouteUrl = (prefix: string) => `http://${proxyAlias}:${proxyPort}${prefix}`;

// A client of this URL must trust `createProxyTls().cert`.
export const proxyTlsRouteUrl = (prefix: string) => `https://${proxyAlias}${prefix}`;

export const createProxyTls = () => createProxyCertificate(proxyAlias);

export const proxyEnvironment = (token: string, noProxy: string[]) => {
  // GNU wget sends no credentials without a password.
  const url = `http://${token}:x@${proxyAlias}:${proxyPort}`;
  const bypass = ["localhost", "127.0.0.1", "::1", ...noProxy].join(",");
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    https_proxy: url,
    http_proxy: url,
    NO_PROXY: bypass,
    no_proxy: bypass,
    NODE_USE_ENV_PROXY: "1",
  };
};

// `placeholder` and `value` are whole header values; `paths` do not include `prefix`.
export type Credential = {
  prefix: string;
  origin: string;
  paths: string[];
  header: string;
  placeholder: string;
  value: string;
};

export type GrantOptions = {
  hosts: true | string[];
  credentialNames?: string[];
};

export type Grant = { hosts: string[] | "*"; credentialNames: string[] };

export type EgressPolicyOptions = {
  // Read at each write, so a write publishes the current values.
  credentials?: () => Record<string, Credential>;
  reachable?: string[];
  certificate?: ProxyCertificate;
};

// Read at each write: an interface can get a new address.
const hostAddresses = () =>
  Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .map(({ address }) => address.split("%")[0]!);

// A new instance revokes the tokens of earlier instances at its first write.
export class EgressPolicy {
  private readonly grants = new Map<string, Grant>();
  private readonly credentials: () => Record<string, Credential>;
  private readonly reachable: string[];
  private readonly certificate?: ProxyCertificate;
  private readonly proxy: string;
  private readonly writes = new SerialQueue();
  private queuedWrite?: Promise<string>;

  constructor(
    name: string,
    { credentials = () => ({}), reachable = [], certificate }: EgressPolicyOptions = {},
  ) {
    this.proxy = runNetworksOf(name).proxy;
    this.credentials = credentials;
    this.reachable = reachable;
    this.certificate = certificate;
  }

  async grant({ hosts, credentialNames = [] }: GrantOptions, token: string = randomUUID()) {
    this.grants.set(token, {
      hosts: hosts === true ? "*" : hosts,
      credentialNames,
    });
    try {
      await this.write();
    } catch (error) {
      this.grants.delete(token);
      throw error;
    }
    return token;
  }

  async revoke(token: string) {
    this.grants.delete(token);
    await this.write();
  }

  // One write at a time, so an earlier state never replaces a later one.
  write() {
    // Changes that wait for a running write share the next write.
    if (this.queuedWrite) return this.queuedWrite;
    const write = this.writes.run(() => {
      this.queuedWrite = undefined;
      const policy = {
        tokens: Object.fromEntries(this.grants),
        credentials: this.credentials(),
        reachable: this.reachable,
        hostAddresses: hostAddresses(),
        certificate: this.certificate,
      };
      return docker(["exec", "--interactive", this.proxy, "sh", "-c", writePolicyScript], {
        input: JSON.stringify(policy),
      });
    });
    this.queuedWrite = write;
    return write;
  }
}
