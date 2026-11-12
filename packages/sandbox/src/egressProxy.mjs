import dns from "node:dns/promises";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { pipeline } from "node:stream";
import tls from "node:tls";

const [policyFile, portText, proxyName, connectionsText] = process.argv.slice(2);
const maxConnections = Number(connectionsText);
if (!Number.isInteger(maxConnections) || maxConnections < 1) {
  process.stderr.write("Give the proxy a connection count of 1 or more\n");
  process.exit(1);
}

const typeOf = (address) => (net.isIPv6(address) ? "ipv6" : "ipv4");

const listOf = (ranges) => {
  const list = new net.BlockList();
  for (const range of ranges) {
    const [address, prefix] = range.split("/");
    if (prefix) list.addSubnet(address, Number(prefix), typeOf(address));
    else list.addAddress(address, typeOf(address));
  }
  return list;
};

// The host, the LAN and cloud metadata. IPv4 ranges also cover IPv4-mapped IPv6.
const blocked = listOf([
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
]);

const emptyPolicy = {
  tokens: {},
  credentials: {},
  reachable: listOf([]),
  hostAddresses: listOf([]),
};

// The policy that `EgressPolicy` in runNetwork.ts writes.
let policy = emptyPolicy;

// A read per request makes a revoke take effect at once.
const readPolicy = () => {
  try {
    const { tokens, credentials, reachable, hostAddresses, certificate } = JSON.parse(
      readFileSync(policyFile, "utf8"),
    );
    policy = {
      tokens,
      credentials,
      reachable: listOf(reachable),
      hostAddresses: listOf(hostAddresses),
      certificate,
    };
  } catch {
    policy = emptyPolicy;
  }
  return policy;
};

const tokenOf = (header) => {
  const [scheme, value] = (header ?? "").split(" ");
  if (scheme !== "Basic" || !value) return undefined;
  return Buffer.from(value, "base64").toString().split(":")[0];
};

// A token name like `__proto__` must not find an inherited property.
const grantOf = (tokens, token) =>
  token && Object.hasOwn(tokens, token) ? tokens[token] : undefined;

const allows = (hosts, host) =>
  hosts === "*" || (Array.isArray(hosts) && hosts.includes(host.toLowerCase()));

const readStatus = (token, host) => {
  const hosts = grantOf(readPolicy().tokens, token)?.hosts;
  if (!hosts) return 407;
  return allows(hosts, host) ? 200 : 403;
};

// The tunnels of each token; a revoke, or a grant without their host, closes them at the next check.
const tunnels = new Map();

// A kept-alive client socket outlives a plain request, so a plain request gives its response.
const track = (token, sockets, { closer = sockets[0], host } = {}) => {
  const open = tunnels.get(token) ?? new Set();
  const tunnel = { sockets, host };
  open.add(tunnel);
  tunnels.set(token, open);
  closer.once("close", () => open.delete(tunnel));
};

setInterval(() => {
  const policy = readPolicy();
  for (const [token, open] of tunnels) {
    const hosts = grantOf(policy.tokens, token)?.hosts;
    for (const tunnel of open) {
      if (hosts && (tunnel.host === undefined || allows(hosts, tunnel.host))) continue;
      for (const socket of tunnel.sockets) socket.destroy();
      open.delete(tunnel);
    }
    if (open.size === 0) tunnels.delete(token);
  }
}, 1000).unref();

// No address: the DNS of the requested name gives it, and `--reach` opens it for all runs.
const unreachableAddressReason =
  "The step cannot reach this address. A runner started with --reach <address> allows it for all its runs";

const addHostHint = "Add the host to its network list in the workflow or in .halinka/config.yml";

const reasons = {
  400: "Bad Request",
  403: `This command cannot reach this host. ${addHostHint}`,
  404: "The step has no credential for this route",
  407: `This command has no valid proxy token. If it needs a host: ${addHostHint}`,
  502: "Bad Gateway",
  503: "The proxy has too many open connections",
};

let connections = 0;

// Count before the lookup, because waiting lookups also use memory.
const counted = (closing) => {
  if (connections >= maxConnections) return false;
  connections += 1;
  closing.once("close", () => (connections -= 1));
  return true;
};

// One lookup, so the connection goes to the address that passed the check.
const findAddress = async (name) => {
  const found = net.isIP(name)
    ? [name]
    : await dns.lookup(name, { all: true }).then(
        (answers) => answers.map(({ address }) => address),
        () => [],
      );
  if (found.length === 0) return { status: 502, reason: "Bad Gateway" };
  const isIn = (list, address) => list.check(address, typeOf(address));
  // A public address of the runner host reaches its services from the egress bridge.
  const isAllowed = (address) =>
    isIn(policy.reachable, address) ||
    !(isIn(blocked, address) || isIn(policy.hostAddresses, address));
  // IPv4 first: the run network often has no IPv6 route.
  const address = found.sort((a, b) => net.isIPv6(a) - net.isIPv6(b)).find(isAllowed);
  if (!address) return { status: 403, reason: unreachableAddressReason };
  return { address };
};

const nameOf = (host) => host.replace(/^\[|\]$/g, "");

const findTarget = async (token, host) => {
  const name = nameOf(host);
  const status = readStatus(token, name);
  if (status !== 200) return { status, reason: reasons[status] };
  return findAddress(name);
};

const hopByHop = [
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "upgrade",
];

const forwardedHeaders = (source) => {
  const headers = { ...source };
  const named = (headers.connection ?? "").split(",").map((name) => name.trim().toLowerCase());
  for (const name of [...hopByHop, ...named]) delete headers[name];
  return headers;
};

const fail = (response) => {
  if (response.headersSent) response.destroy();
  else response.writeHead(502).end();
};

// A pooled upstream socket would serve the next token, and its revoke would close it.
const pipeThrough = (token, request, response, client, target) => {
  const upstream = client.request({ ...target, method: request.method, agent: false });
  upstream.on("response", (answer) => {
    response.writeHead(answer.statusCode ?? 502, forwardedHeaders(answer.headers));
    pipeline(answer, response, () => {});
  });
  track(token, [request.socket, upstream], { closer: response });
  response.once("close", () => upstream.destroy());
  upstream.on("error", () => fail(response));
  request.pipe(upstream);
};

const refuse = (response, status, reason = reasons[status]) =>
  response.writeHead(status, reason).end(`${reason}\n`);

const established = "HTTP/1.1 200 Connection Established\r\n\r\n";

const refuseTunnel = (socket, status, reason = reasons[status]) =>
  socket.end(`HTTP/1.1 ${status} ${reason}\r\n\r\n`);

const forwardRoute = async (token, request, response, url) => {
  const { tokens, credentials } = readPolicy();
  const grant = grantOf(tokens, token);
  if (!grant) return refuse(response, 407);
  const matching = grant.credentialNames
    .map((name) => credentials[name])
    .filter((entry) => entry && url.pathname.startsWith(`${entry.prefix}/`));
  if (matching.length === 0) return refuse(response, 404);
  // A credential of another origin must not go to this origin.
  const routed = matching.filter(
    ({ prefix, origin }) => prefix === matching[0].prefix && origin === matching[0].origin,
  );
  const path = url.pathname.slice(routed[0].prefix.length);
  const headers = forwardedHeaders(request.headers);
  const sent = routed.filter(
    ({ header, placeholder }) => headers[header.toLowerCase()] === placeholder,
  );
  const lent = sent.find(({ paths }) => paths.includes(path));
  // A 401 of the provider looks like a bad key, and a new path of a new agent version must show.
  if (sent.length > 0 && !lent)
    return refuse(response, 403, `Halinka lends no credential on ${path}`);
  const origin = new URL(routed[0].origin);
  const name = nameOf(origin.hostname);
  const { address, status, reason } = await findAddress(name);
  if (request.socket.destroyed) return;
  if (!address) return refuse(response, status, reason);
  for (const { header } of routed) delete headers[header.toLowerCase()];
  if (lent) headers[lent.header.toLowerCase()] = lent.value;
  headers.host = origin.host;
  pipeThrough(token, request, response, https, {
    host: address,
    port: origin.port || 443,
    // SNI must not be an IP address.
    servername: net.isIP(name) ? undefined : name,
    path: `${path}${url.search}`,
    headers,
  });
};

const forward = async (request, response) => {
  const url = URL.parse(request.url ?? "");
  if (!url || url.protocol !== "http:") {
    response.writeHead(400).end();
    return;
  }
  const token = tokenOf(request.headers["proxy-authorization"]);
  if (url.hostname === proxyName) return forwardRoute(token, request, response, url);
  const { address, status, reason } = await findTarget(token, url.hostname);
  if (request.socket.destroyed) return;
  if (!address) return refuse(response, status, reason);
  pipeThrough(token, request, response, http, {
    host: address,
    port: url.port || 80,
    path: `${url.pathname}${url.search}`,
    headers: forwardedHeaders(request.headers),
  });
};

// A throw must not stop the proxy for all its tokens.
const server = http.createServer((request, response) => {
  if (!counted(response)) return refuse(response, 503);
  forward(request, response).catch(() => fail(response));
});

const tunnelTokens = new WeakMap();
const tunnelRouteServer = http.createServer((request, response) => {
  const url = URL.parse(`https://${proxyName}${request.url ?? ""}`);
  if (!url) return refuse(response, 400);
  forwardRoute(tunnelTokens.get(request.socket), request, response, url).catch(() =>
    fail(response),
  );
});

// An HTTPS client sends a route request only through a CONNECT.
const openRouteTunnel = (token, socket, head) => {
  const { tokens, certificate } = readPolicy();
  if (!grantOf(tokens, token)) return refuseTunnel(socket, 407);
  if (!certificate) return refuseTunnel(socket, 404);
  // A TLS server, not a bare TLSSocket: only a server's sockets report TLS errors after the handshake.
  const tunnel = tls.createServer(
    { key: certificate.key, cert: certificate.cert, ALPNProtocols: ["http/1.1"] },
    (secure) => {
      tunnelTokens.set(secure, token);
      tunnelRouteServer.emit("connection", secure);
    },
  );
  tunnel.on("tlsClientError", () => socket.destroy());
  socket.write(established);
  if (head.length > 0) socket.unshift(head);
  track(token, [socket]);
  tunnel.emit("connection", socket);
};

const openTunnel = async (request, socket, head) => {
  const [host = "", port = "443"] = (request.url ?? "").split(/:(?=\d+$)/);
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    refuseTunnel(socket, 400);
    return;
  }
  // The client can close the socket while the proxy waits.
  socket.on("error", () => socket.destroy());
  if (!counted(socket)) {
    refuseTunnel(socket, 503);
    return;
  }
  const token = tokenOf(request.headers["proxy-authorization"]);
  if (nameOf(host) === proxyName && portNumber === 443) return openRouteTunnel(token, socket, head);
  const { address, status, reason } = await findTarget(token, host);
  if (socket.destroyed) return;
  if (!address) {
    refuseTunnel(socket, status, reason);
    return;
  }
  const upstream = net.connect(portNumber, address, () => {
    socket.write(established);
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  track(token, [socket, upstream], { host });
  upstream.on("error", () => refuseTunnel(socket, 502));
  socket.on("error", () => upstream.destroy());
};

// A throw must not stop the proxy for all its tokens.
server.on("connect", (request, socket, head) => {
  openTunnel(request, socket, head).catch(() => socket.destroy());
});

server.listen(Number(portText), "0.0.0.0");
