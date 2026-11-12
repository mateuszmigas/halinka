import { randomInt } from "node:crypto";

import { describe, expect, it, onTestFinished } from "vitest";

import { deleteDevcontainer } from "./devcontainer";
import { createProxyTls, EgressPolicy, runNetworksOf, startRunNetwork } from "./runNetwork";
import {
  docker,
  dockerAddressPools,
  readProxyPolicy,
  startOutsideHost,
  testCredential,
} from "./testing";

const node = "node:22-alpine";

const setUp = async (reachable = dockerAddressPools) => {
  const name = `halinka-test-${randomInt(1_000_000)}`;
  const { internal } = runNetworksOf(name);
  await startRunNetwork(name);
  onTestFinished(() => deleteDevcontainer(name));
  const policy = new EgressPolicy(name, { reachable });
  const written = () => readProxyPolicy(name)!;
  const outside = startOutsideHost(name);
  onTestFinished(() => {
    outside.delete();
  });
  const { host } = outside;
  const request = (script: string) =>
    docker("run", "--rm", "--network", internal, node, "node", "-e", script);
  const throughProxy = (token: string) =>
    request(
      `require("http").get({ host: "halinka-proxy", port: 3128, path: "http://${host}:8080/", headers: { "proxy-authorization": "Basic " + Buffer.from("${token}:").toString("base64") } }, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => console.log(r.statusCode, b)); }).on("error", (e) => console.log(e.code));`,
    );
  return { name, host, policy, written, request, throughProxy };
};

describe("runNetwork", { timeout: 60_000 }, () => {
  it("gives a command in the run network no direct way out", async () => {
    const { host, request } = await setUp();

    expect(
      request(
        `require("http").get("http://${host}:8080/", () => console.log("reached")).on("error", (e) => console.log(e.code));`,
      ),
    ).toBe("EAI_AGAIN");
  });

  it("limits the memory of the proxy, without swap", async () => {
    const { name } = await setUp();

    const memory = "{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}";
    expect(docker("inspect", runNetworksOf(name).proxy, "--format", memory)).toBe(
      "268435456 268435456",
    );
  });

  it("lets a token reach a host of its list through the proxy", async () => {
    const { host, policy, throughProxy } = await setUp();
    const token = await policy.grant({ hosts: [host] });

    await expect.poll(() => throughProxy(token)).toBe("200 outside");
  });

  it("refuses a host outside the list of the token", async () => {
    const { policy, throughProxy } = await setUp();
    const token = await policy.grant({ hosts: ["registry.npmjs.org"] });

    await expect.poll(() => throughProxy(token)).toMatch(/^403/);
  });

  it("refuses a host on a private network that the policy does not make reachable", async () => {
    const { host, policy, throughProxy } = await setUp([]);
    const token = await policy.grant({ hosts: [host] });

    await expect.poll(() => throughProxy(token)).toMatch(/^403 The step cannot reach this address/);
  });

  it("writes the hosts of a granted token", async () => {
    const { policy, written } = await setUp();

    const token = await policy.grant({ hosts: ["api.anthropic.com"] });

    expect(written().tokens).toEqual({
      [token]: { hosts: ["api.anthropic.com"], credentialNames: [] },
    });
  });

  it("writes all hosts as *", async () => {
    const { policy, written } = await setUp();

    const token = await policy.grant({ hosts: true });

    expect(written().tokens).toEqual({ [token]: { hosts: "*", credentialNames: [] } });
  });

  it("removes a revoked token", async () => {
    const { policy, written } = await setUp();
    const token = await policy.grant({ hosts: true });

    await policy.revoke(token);

    expect(written().tokens).toEqual({});
  });

  it("publishes the current credentials", async () => {
    const { name, written } = await setUp();
    let credentials = {};
    const policy = new EgressPolicy(name, { credentials: () => credentials });
    await policy.write();
    const credential = testCredential("https://api.anthropic.com");
    credentials = { anthropic: credential };

    await policy.write();

    expect(written().credentials).toEqual({ anthropic: credential });
  });

  it("writes the credential names of a token", async () => {
    const { policy, written } = await setUp();

    const token = await policy.grant({ hosts: [], credentialNames: ["anthropic"] });

    expect(written().tokens[token]?.credentialNames).toEqual(["anthropic"]);
  });

  it("writes the reachable addresses", async () => {
    const { policy, written } = await setUp(["10.0.0.0/8"]);

    await policy.write();

    expect(written().reachable).toEqual(["10.0.0.0/8"]);
  });

  it("writes the addresses of the runner host", async () => {
    const { policy, written } = await setUp();

    await policy.write();

    expect(written().hostAddresses).toContain("127.0.0.1");
  });

  it("writes the key pair of the proxy", async () => {
    const { name, written } = await setUp();
    const certificate = createProxyTls();

    await new EgressPolicy(name, { certificate }).write();

    expect(written().certificate).toEqual(certificate);
  });

  it("revokes the tokens of an earlier process at its first write", async () => {
    const { name, policy, written } = await setUp();
    await policy.grant({ hosts: true });

    const token = await new EgressPolicy(name).grant({ hosts: true });

    expect(Object.keys(written().tokens)).toEqual([token]);
  });

  it("rejects a grant when the proxy is stopped", async () => {
    const { name, policy } = await setUp();

    docker("stop", runNetworksOf(name).proxy);

    await expect(policy.grant({ hosts: true })).rejects.toThrow(/\S/);
  });

  it("drops a token whose grant failed", async () => {
    const { name, policy, written } = await setUp();
    docker("stop", runNetworksOf(name).proxy);
    await policy.grant({ hosts: true }).catch(() => {});
    docker("start", runNetworksOf(name).proxy);

    const token = await policy.grant({ hosts: true });

    expect(Object.keys(written().tokens)).toEqual([token]);
  });
});
