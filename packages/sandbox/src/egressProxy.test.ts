import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import tls from "node:tls";

import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it, onTestFinished } from "vitest";

import { createProxyCertificate, type ProxyCertificate } from "./proxyCertificate";
import { testCertificate, testCredential, testKey } from "./testing";

const proxyScript = new URL("./egressProxy.mjs", import.meta.url).pathname;
const proxyName = "halinka-proxy";
const proxyTls = createProxyCertificate(proxyName);

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

const auth = (token: string) => `Basic ${Buffer.from(`${token}:`).toString("base64")}`;

const listenOnLoopback = async (server: net.Server) => {
  server.on("connection", (socket) => onTestFinished(() => void socket.destroy()));
  await once(server.listen(0, "127.0.0.1"), "listening");
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as net.AddressInfo).port;
};

const setUp = async ({ connections = 512 } = {}) => {
  const folder = await tempFolder();
  const policyFile = join(folder, "policy.json");
  const certificateFile = join(folder, "certificate.pem");
  await writeFile(certificateFile, testCertificate);
  const writePolicy = (policy: object) => writeFile(policyFile, JSON.stringify(policy));
  // The targets of the tests listen on loopback.
  const setPolicy = (
    hostsByToken: Record<string, string[] | "*">,
    reachable = ["127.0.0.1"],
    hostAddresses: string[] = [],
  ) => {
    const grants = Object.entries(hostsByToken).map(([token, hosts]) => [
      token,
      { hosts, credentialNames: [] },
    ]);
    const tokens = Object.fromEntries(grants);
    return writePolicy({ tokens, credentials: {}, reachable, hostAddresses });
  };
  await setPolicy({});
  const provider = https.createServer(
    { key: testKey, cert: testCertificate },
    (request, response) => {
      const {
        host,
        authorization = null,
        "x-api-key": key = null,
        "x-trace": trace = null,
      } = request.headers;
      response.setHeader("connection", "close, x-hop");
      response.setHeader("x-hop", "1");
      response.end(JSON.stringify({ path: request.url, host, authorization, key, trace }));
    },
  );
  const providerPort = await listenOnLoopback(provider);
  const setRoutePolicy = (
    credentialNames: string[],
    {
      origin = `https://localhost:${providerPort}`,
      reachable = ["127.0.0.1"],
      hosts = [] as string[] | "*",
      certificate = proxyTls as ProxyCertificate | null,
    } = {},
  ) => {
    const anthropic = testCredential(origin);
    const oauth = {
      ...anthropic,
      header: "Authorization",
      placeholder: "Bearer sk-ant-oat01-placeholder",
      value: "Bearer sk-ant-oat01-real",
    };
    const other = { ...oauth, origin: "https://other.invalid", value: "Bearer other-real" };
    return writePolicy({
      tokens: { t1: { hosts, credentialNames } },
      credentials: { anthropic, oauth, other },
      reachable,
      hostAddresses: [],
      certificate,
    });
  };
  const target = http.createServer((request, response) => {
    if (request.url === "/stream") response.write("start");
    else if (request.url === "/broken") response.write("start", () => request.socket.destroy());
    else response.end(`${request.headers["proxy-authorization"] ?? "no proxy header"}`);
  });
  const targetPort = await listenOnLoopback(target);
  const proxyPort = await freePort();
  const proxy = spawn(
    process.execPath,
    [proxyScript, policyFile, String(proxyPort), proxyName, String(connections)],
    { env: { ...process.env, NODE_EXTRA_CA_CERTS: certificateFile } },
  );
  onTestFinished(() => void proxy.kill());
  let errors = "";
  proxy.stderr.on("data", (chunk) => (errors += chunk));
  await expect
    .poll(
      () =>
        new Promise((resolve) => {
          const socket = net.connect(proxyPort, "127.0.0.1", () => resolve(socket.end()));
          socket.on("error", () => resolve(undefined));
        }),
      { timeout: 10_000 },
    )
    .toBeDefined();
  const open = (token: string, path = `127.0.0.1:${targetPort}`) =>
    new Promise<{ status: string; socket: net.Socket }>((resolve) => {
      const request = http.request({
        host: "127.0.0.1",
        port: proxyPort,
        method: "CONNECT",
        path,
        headers: { "proxy-authorization": auth(token) },
      });
      request.on("connect", (response, socket) => {
        onTestFinished(() => void socket.destroy());
        resolve({ status: String(response.statusCode), socket });
      });
      request.end();
    });
  const connect = async (token: string, path?: string) => (await open(token, path)).status;
  const sendRequest = (
    token: string,
    url: string,
    { agent, headers = {} }: { agent?: http.Agent; headers?: Record<string, string> } = {},
  ) =>
    new Promise<http.IncomingMessage>((resolve) =>
      http.get(
        {
          host: "127.0.0.1",
          port: proxyPort,
          path: url,
          headers: { "proxy-authorization": auth(token), ...headers },
          agent,
        },
        resolve,
      ),
    );
  const get = async (token: string, agent?: http.Agent) => {
    const response = await sendRequest(token, `http://127.0.0.1:${targetPort}/`, { agent });
    return `${response.statusCode} ${await text(response)}`;
  };
  const stream = (token: string, path = "/stream") =>
    sendRequest(token, `http://127.0.0.1:${targetPort}${path}`);
  const route = async (token: string, path: string, headers?: Record<string, string>) => {
    const response = await sendRequest(token, `http://${proxyName}:3128${path}`, { headers });
    return { status: response.statusCode, headers: response.headers, body: await text(response) };
  };
  const routeOverTls = async (
    token: string,
    path: string,
    { headers, ca = proxyTls.cert }: { headers?: Record<string, string>; ca?: string } = {},
  ) => {
    const { status, socket } = await open(token, `${proxyName}:443`);
    if (status !== "200") return { status, body: "" };
    const secure = tls.connect({ socket, servername: proxyName, ca });
    const response = await new Promise<http.IncomingMessage>((resolve) =>
      http.get({ createConnection: () => secure, host: proxyName, path, headers }, resolve),
    );
    return { status: String(response.statusCode), body: await text(response) };
  };
  const deletePolicy = () => rm(policyFile);
  return {
    setPolicy,
    setRoutePolicy,
    route,
    routeOverTls,
    deletePolicy,
    open,
    connect,
    get,
    stream,
    errors: () => errors,
    proxyPort,
    providerPort,
    targetPort,
  };
};

// Each test starts a process and polls up to 10 s for it.
describe("egressProxy", { timeout: 30_000 }, () => {
  it("connects a token to a host of its list", async () => {
    const { setPolicy, connect } = await setUp();
    await setPolicy({ t1: ["127.0.0.1"] });

    expect(await connect("t1")).toBe("200");
  });

  it("refuses a host outside the list of the token", async () => {
    const { setPolicy, connect } = await setUp();
    await setPolicy({ t1: ["registry.npmjs.org"] });

    expect(await connect("t1")).toBe("403");
  });

  it("refuses a token that the runner revoked", async () => {
    const { setPolicy, connect } = await setUp();
    await setPolicy({ t1: "*" });
    await connect("t1");

    await setPolicy({});

    expect(await connect("t1")).toBe("407");
  });

  it("keeps working when a client closes before its answer", async () => {
    const { setPolicy, connect, proxyPort } = await setUp();
    await setPolicy({ t1: "*" });
    const client = net.connect(proxyPort, "127.0.0.1");
    client.on("error", () => {});
    client.write(`CONNECT 127.0.0.1:1 HTTP/1.1\r\nProxy-Authorization: ${auth("t2")}\r\n\r\n`);

    client.resetAndDestroy();

    expect(await connect("t1")).toBe("200");
  });

  it("refuses every token when the file is missing", async () => {
    const { setPolicy, deletePolicy, connect } = await setUp();
    await setPolicy({ t1: "*" });
    await connect("t1");

    await deletePolicy();

    expect(await connect("t1")).toBe("407");
  });

  it("refuses a port that is not a port", async () => {
    const { setPolicy, connect } = await setUp();
    await setPolicy({ t1: "*" });

    expect(await connect("t1", "127.0.0.1:99999")).toBe("400");
  });

  it("keeps working after a port that is not a port", async () => {
    const { setPolicy, connect } = await setUp();
    await setPolicy({ t1: "*" });
    await connect("t1", "127.0.0.1:99999");

    expect(await connect("t1")).toBe("200");
  });

  it("closes the open tunnel of a token that the runner revoked", async () => {
    const { setPolicy, open } = await setUp();
    await setPolicy({ t1: "*" });
    const { socket } = await open("t1");
    const closed = new Promise((resolve) => socket.on("close", resolve));

    await setPolicy({});

    await expect(closed).resolves.toBe(false);
  });

  it("closes the open tunnel to a host that a new grant of its token leaves out", async () => {
    const { setPolicy, open } = await setUp();
    await setPolicy({ t1: ["127.0.0.1"] });
    const { socket } = await open("t1");
    const closed = new Promise((resolve) => socket.on("close", resolve));

    await setPolicy({ t1: ["other.example"] });

    await expect(closed).resolves.toBe(false);
  });

  it("keeps the open tunnel to a host that a new grant of its token keeps", async () => {
    const { setPolicy, open } = await setUp();
    await setPolicy({ t1: ["127.0.0.1"], t2: "*" });
    const kept = await open("t1");
    const revoked = await open("t2");
    // The close of the revoked tunnel shows that a check ran.
    const checked = new Promise((resolve) => revoked.socket.on("close", resolve));

    await setPolicy({ t1: ["127.0.0.1", "other.example"] });
    await checked;

    expect(kept.socket.destroyed).toBe(false);
  });

  it("closes the open plain request of a token that the runner revoked", async () => {
    const { setPolicy, stream } = await setUp();
    await setPolicy({ t1: "*" });
    const response = await stream("t1");
    const closed = new Promise((resolve) => response.on("close", resolve));

    await setPolicy({});

    await expect(closed).resolves.toBeUndefined();
  });

  it("forwards many plain requests on one kept-alive connection without a warning", async () => {
    const { setPolicy, get, errors } = await setUp();
    await setPolicy({ t1: "*" });
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    onTestFinished(() => agent.destroy());

    for (let index = 0; index < 20; index++) await get("t1", agent);
    expect(await get("t1", agent)).toBe("200 no proxy header");

    expect(errors()).toBe("");
  });

  it("forwards a plain request without the proxy token", async () => {
    const { setPolicy, get } = await setUp();
    await setPolicy({ t1: "*" });

    expect(await get("t1")).toBe("200 no proxy header");
  });

  it.each([
    ["a loopback address", (port: number) => `127.0.0.1:${port}`],
    ["a name of a loopback address", (port: number) => `localhost:${port}`],
    ["an IPv4-mapped loopback address", (port: number) => `[::ffff:127.0.0.1]:${port}`],
    ["a private address", () => "10.0.0.1:443"],
    ["the cloud metadata address", () => "169.254.169.254:80"],
    ["an IPv6 loopback address", (port: number) => `[::1]:${port}`],
    ["a unique-local IPv6 address", () => "[fd00::1]:443"],
  ])("refuses a tunnel to %s", async (_, pathOf) => {
    const { setPolicy, connect, targetPort } = await setUp();
    await setPolicy({ t1: "*" }, []);

    expect(await connect("t1", pathOf(targetPort))).toBe("403");
  });

  it("tells a command where to add a refused host", async () => {
    const { setPolicy, get } = await setUp();
    await setPolicy({ t1: ["example.com"] }, []);

    expect(await get("t1")).toBe(
      "403 This command cannot reach this host. Add the host to its network list in the workflow or in .halinka/config.yml\n",
    );
  });

  it("tells a command without a token where to add the host", async () => {
    const { setPolicy, get } = await setUp();
    await setPolicy({}, []);

    expect(await get("t1")).toBe(
      "407 This command has no valid proxy token. If it needs a host: Add the host to its network list in the workflow or in .halinka/config.yml\n",
    );
  });

  it("refuses a plain request to a loopback address", async () => {
    const { setPolicy, get } = await setUp();
    await setPolicy({ t1: "*" }, []);

    expect(await get("t1")).toBe(
      "403 The step cannot reach this address. A runner started with --reach <address> allows it for all its runs\n",
    );
  });

  it("refuses an address of the runner host", async () => {
    const { setPolicy, connect } = await setUp();
    await setPolicy({ t1: "*" }, [], ["203.0.113.7"]);

    expect(await connect("t1", "203.0.113.7:443")).toBe("403");
  });

  it("connects to an address of the runner host that --reach allows", async () => {
    const { setPolicy, connect } = await setUp();
    await setPolicy({ t1: "*" }, ["127.0.0.1"], ["127.0.0.1"]);

    expect(await connect("t1")).toBe("200");
  });

  it("connects to an address in a reachable range", async () => {
    const { setPolicy, connect } = await setUp();
    await setPolicy({ t1: "*" }, ["127.0.0.0/8"]);

    expect(await connect("t1")).toBe("200");
  });

  it("answers 502 when the host name does not resolve", async () => {
    const { setPolicy, connect } = await setUp();
    await setPolicy({ t1: "*" });

    expect(await connect("t1", "nohost.invalid:443")).toBe("502");
  });

  it("gives the credential to an allowed path of a route", async () => {
    const { setRoutePolicy, route } = await setUp();
    await setRoutePolicy(["anthropic"]);

    const { body } = await route("t1", "/anthropic/v1/messages", {
      "x-api-key": "sk-ant-api03-placeholder",
    });

    expect(JSON.parse(body).key).toBe("sk-ant-api03-real");
  });

  it("gives the credential to each exact path of its list", async () => {
    const { setRoutePolicy, route } = await setUp();
    await setRoutePolicy(["anthropic"]);

    const { body } = await route("t1", "/anthropic/v1/messages/count_tokens", {
      "x-api-key": "sk-ant-api03-placeholder",
    });

    expect(JSON.parse(body).key).toBe("sk-ant-api03-real");
  });

  it.each([
    "/v1/models",
    "/v1/messagesX",
    "/v1/messages/batches",
    "/v1/messages/..%2Fbatches",
    "/v1/messages/",
  ])("refuses the placeholder on %s, a path outside the list", async (path) => {
    const { setRoutePolicy, route } = await setUp();
    await setRoutePolicy(["anthropic"]);

    const { status, body } = await route("t1", `/anthropic${path}`, {
      "x-api-key": "sk-ant-api03-placeholder",
    });

    expect({ status, body }).toEqual({
      status: 403,
      body: `Halinka lends no credential on ${path}\n`,
    });
  });

  it("gives the credential whose placeholder the client sends on a shared route", async () => {
    const { setRoutePolicy, route } = await setUp();
    await setRoutePolicy(["anthropic", "oauth"]);

    const { body } = await route("t1", "/anthropic/v1/messages", {
      authorization: "Bearer sk-ant-oat01-placeholder",
    });

    expect(JSON.parse(body).authorization).toBe("Bearer sk-ant-oat01-real");
  });

  it("refuses the placeholder of the second credential of a shared route outside the list", async () => {
    const { setRoutePolicy, route } = await setUp();
    await setRoutePolicy(["anthropic", "oauth"]);

    const { status } = await route("t1", "/anthropic/v1/models", {
      authorization: "Bearer sk-ant-oat01-placeholder",
    });

    expect(status).toBe(403);
  });

  it("gives the credential to an exact path with a query", async () => {
    const { setRoutePolicy, route } = await setUp();
    await setRoutePolicy(["anthropic"]);

    const { body } = await route("t1", "/anthropic/v1/messages?beta=true", {
      "x-api-key": "sk-ant-api03-placeholder",
    });

    expect(JSON.parse(body).key).toBe("sk-ant-api03-real");
  });

  it("forwards a route to the path without the prefix, with its query", async () => {
    const { setRoutePolicy, route } = await setUp();
    await setRoutePolicy(["anthropic"]);

    const { body } = await route("t1", "/anthropic/v1/messages?beta=true");

    expect(JSON.parse(body).path).toBe("/v1/messages?beta=true");
  });

  it("sends the provider its own host name", async () => {
    const { setRoutePolicy, route, providerPort } = await setUp();
    await setRoutePolicy(["anthropic"]);

    const { body } = await route("t1", "/anthropic/v1/messages");

    expect(JSON.parse(body).host).toBe(`localhost:${providerPort}`);
  });

  it("sends no credential when the header is not the placeholder", async () => {
    const { setRoutePolicy, route } = await setUp();
    await setRoutePolicy(["anthropic"]);

    const { body } = await route("t1", "/anthropic/v1/messages", {
      "x-api-key": "sk-ant-api03-other",
    });

    expect(JSON.parse(body).key).toBeNull();
  });

  it("refuses a route of a credential that the token does not have", async () => {
    const { setRoutePolicy, route } = await setUp();
    await setRoutePolicy([]);

    expect((await route("t1", "/anthropic/v1/messages")).status).toBe(404);
  });

  it("refuses a path that only starts like a prefix", async () => {
    const { setRoutePolicy, route } = await setUp();
    await setRoutePolicy(["anthropic"]);

    expect((await route("t1", "/anthropicX/v1/messages")).status).toBe(404);
  });

  it("gives the credential to a route inside a tunnel to the proxy", async () => {
    const { setRoutePolicy, routeOverTls } = await setUp();
    await setRoutePolicy(["anthropic"]);

    const { body } = await routeOverTls("t1", "/anthropic/v1/messages", {
      headers: { "x-api-key": "sk-ant-api03-placeholder" },
    });

    expect(JSON.parse(body).key).toBe("sk-ant-api03-real");
  });

  it("refuses the placeholder on a path outside the list inside a tunnel to the proxy", async () => {
    const { setRoutePolicy, routeOverTls } = await setUp();
    await setRoutePolicy(["anthropic"]);

    const { status } = await routeOverTls("t1", "/anthropic/v1/messages/batches", {
      headers: { "x-api-key": "sk-ant-api03-placeholder" },
    });

    expect(status).toBe("403");
  });

  it("refuses a tunnel to the proxy with an unknown token", async () => {
    const { setRoutePolicy, routeOverTls } = await setUp();
    await setRoutePolicy(["anthropic"]);

    expect((await routeOverTls("t2", "/anthropic/v1/messages")).status).toBe("407");
  });

  it("refuses a tunnel to the proxy when the runner gave no certificate", async () => {
    const { setRoutePolicy, routeOverTls } = await setUp();
    await setRoutePolicy(["anthropic"], { certificate: null });

    expect((await routeOverTls("t1", "/anthropic/v1/messages")).status).toBe("404");
  });

  it("closes the open tunnel to the proxy of a token that the runner revoked", async () => {
    const { setRoutePolicy, setPolicy, open } = await setUp();
    await setRoutePolicy(["anthropic"]);
    const { socket } = await open("t1", `${proxyName}:443`);
    const secure = tls.connect({ socket, servername: proxyName, ca: proxyTls.cert });
    await once(secure, "secureConnect");
    const closed = new Promise((resolve) => secure.on("close", resolve));

    await setPolicy({});

    await expect(closed).resolves.toBe(false);
  });

  it("serves TLS in a tunnel to the proxy to a client that sends no host name", async () => {
    const { setRoutePolicy, open } = await setUp();
    await setRoutePolicy(["anthropic"]);
    const { socket } = await open("t1", `${proxyName}:443`);

    const secure = tls.connect({
      socket,
      ca: proxyTls.cert,
      checkServerIdentity: () => undefined,
    });

    await expect(once(secure, "secureConnect")).resolves.toBeDefined();
  });

  it("closes a tunnel to the proxy after a broken TLS record", async () => {
    const { setRoutePolicy, open } = await setUp();
    await setRoutePolicy(["anthropic"]);
    const { socket } = await open("t1", `${proxyName}:443`);
    const secure = tls.connect({ socket, servername: proxyName, ca: proxyTls.cert });
    secure.on("error", () => {});
    await once(secure, "secureConnect");
    const closed = new Promise((resolve) => socket.on("close", resolve));

    socket.write(Buffer.from("not a TLS record"));

    await expect(closed).resolves.toBeDefined();
  });

  it("keeps working after it closes a tunnel to the proxy with a broken certificate", async () => {
    const { setRoutePolicy, route, proxyPort } = await setUp();
    await setRoutePolicy(["anthropic"], { certificate: { key: "broken", cert: "broken" } });
    const tunnel = http.request({
      host: "127.0.0.1",
      port: proxyPort,
      method: "CONNECT",
      path: `${proxyName}:443`,
      headers: { "proxy-authorization": auth("t1") },
    });
    const closed = new Promise((resolve) => tunnel.on("error", resolve));
    tunnel.end();
    await closed;

    expect((await route("t1", "/anthropic/v1/messages")).status).toBe(200);
  });

  it("serves the certificate of the current policy after a new key", async () => {
    const { setRoutePolicy, routeOverTls } = await setUp();
    await setRoutePolicy(["anthropic"]);
    await routeOverTls("t1", "/anthropic/v1/messages");
    const next = createProxyCertificate(proxyName);
    await setRoutePolicy(["anthropic"], { certificate: next });

    const { status } = await routeOverTls("t1", "/anthropic/v1/messages", { ca: next.cert });

    expect(status).toBe("200");
  });

  it("refuses a route request with an unknown token", async () => {
    const { setRoutePolicy, route } = await setUp();
    await setRoutePolicy(["anthropic"]);

    expect((await route("t2", "/anthropic/v1/messages")).status).toBe(407);
  });

  it.each(["__proto__", "constructor"])(
    "refuses a route request with the token %s, and keeps working",
    async (token) => {
      const { setRoutePolicy, route } = await setUp();
      await setRoutePolicy(["anthropic"]);

      expect((await route(token, "/anthropic/v1/messages")).status).toBe(407);
      expect((await route("t1", "/anthropic/v1/messages")).status).toBe(200);
    },
  );

  it("refuses a route to a provider address that the step cannot reach", async () => {
    const { setRoutePolicy, route } = await setUp();
    await setRoutePolicy(["anthropic"], { reachable: [] });

    expect(await route("t1", "/anthropic/v1/messages")).toMatchObject({
      status: 403,
      body: "The step cannot reach this address. A runner started with --reach <address> allows it for all its runs\n",
    });
  });

  it("answers 502 when the provider of a route does not answer", async () => {
    const { setRoutePolicy, route } = await setUp();
    await setRoutePolicy(["anthropic"], { origin: `https://localhost:${await freePort()}` });

    expect((await route("t1", "/anthropic/v1/messages")).status).toBe(502);
  });

  it("answers 502 when the route throws", async () => {
    const { setRoutePolicy, route } = await setUp();
    await setRoutePolicy(["anthropic"], { origin: "not a url" });

    expect((await route("t1", "/anthropic/v1/messages")).status).toBe(502);
  });

  it("checks the address of an IPv6 origin without its brackets", async () => {
    const { setRoutePolicy, route } = await setUp();
    await setRoutePolicy(["anthropic"], { origin: "https://[::1]:1", reachable: [] });

    expect(await route("t1", "/anthropic/v1/messages")).toMatchObject({
      status: 403,
      body: "The step cannot reach this address. A runner started with --reach <address> allows it for all its runs\n",
    });
  });

  it("removes the headers that `connection` names from the request", async () => {
    const { setRoutePolicy, route } = await setUp();
    await setRoutePolicy(["anthropic"]);

    const { body } = await route("t1", "/anthropic/v1/messages", {
      connection: "x-trace",
      "x-trace": "1",
    });

    expect(JSON.parse(body).trace).toBeNull();
  });

  it("removes the headers that `connection` names from the answer", async () => {
    const { setRoutePolicy, route } = await setUp();
    await setRoutePolicy(["anthropic"]);

    const { headers } = await route("t1", "/anthropic/v1/messages");

    expect(headers["x-hop"]).toBeUndefined();
  });

  it("does not send a credential of another origin on a shared prefix", async () => {
    const { setRoutePolicy, route } = await setUp();
    await setRoutePolicy(["anthropic", "other"]);

    const { body } = await route("t1", "/anthropic/v1/messages", {
      authorization: "Bearer sk-ant-oat01-placeholder",
    });

    expect(JSON.parse(body).authorization).toBe("Bearer sk-ant-oat01-placeholder");
  });

  it("answers 502 when the provider certificate is not for the origin host", async () => {
    const { setRoutePolicy, route, providerPort } = await setUp();
    await setRoutePolicy(["anthropic"], { origin: `https://127.0.0.1:${providerPort}` });

    expect((await route("t1", "/anthropic/v1/messages")).status).toBe(502);
  });

  it("refuses a tunnel above the connection count with 503", async () => {
    const { setPolicy, open, connect } = await setUp({ connections: 2 });
    await setPolicy({ t1: "*" });
    await open("t1");
    await open("t1");

    expect(await connect("t1")).toBe("503");
  });

  it("refuses a credential route above the connection count with 503", async () => {
    const { setRoutePolicy, open, route } = await setUp({ connections: 2 });
    await setRoutePolicy(["anthropic"], { hosts: "*" });
    await open("t1");
    await open("t1");

    expect((await route("t1", "/anthropic/v1/messages")).status).toBe(503);
  });

  it("does not start without a connection count", async () => {
    const proxy = spawn(process.execPath, [proxyScript, "policy.json", "0", proxyName]);

    const [code] = await once(proxy, "exit");

    expect(code).toBe(1);
  });

  it("counts a tunnel no more after it closes", async () => {
    const { setPolicy, open, connect } = await setUp({ connections: 1 });
    await setPolicy({ t1: "*" });
    const { socket } = await open("t1");

    socket.destroy();

    await expect.poll(() => connect("t1")).toBe("200");
  });

  it("counts a request no more after its upstream breaks in the body", async () => {
    const { setPolicy, stream, get } = await setUp({ connections: 1 });
    await setPolicy({ t1: "*" });
    await stream("t1", "/broken");

    await expect.poll(() => get("t1")).toMatch(/^200 /);
  });

  it("counts a refused route no more after its answer", async () => {
    const { setRoutePolicy, route } = await setUp({ connections: 1 });
    await setRoutePolicy(["anthropic"]);
    await route("t1", "/other/v1/messages");

    expect((await route("t1", "/anthropic/v1/messages")).status).toBe(200);
  });
});
