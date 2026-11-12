import { createPrivateKey, X509Certificate } from "node:crypto";
import { once } from "node:events";
import tls from "node:tls";

import { describe, expect, it, onTestFinished } from "vitest";

import { createProxyCertificate, type ProxyCertificate } from "./proxyCertificate";

const handshake = async (serverPair: ProxyCertificate, ca: string, name: string) => {
  const server = tls.createServer(serverPair, (socket) => socket.end("hello"));
  onTestFinished(() => {
    server.close();
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const { port } = server.address() as { port: number };
  return new Promise<string>((resolve) => {
    const socket = tls.connect({ host: "127.0.0.1", port, servername: name, ca }, () => {
      socket.once("data", (data) => resolve(String(data)));
    });
    socket.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
  });
};

describe("createProxyCertificate", () => {
  it("makes a certificate for the host name", () => {
    const { cert } = createProxyCertificate("halinka-proxy");

    expect(new X509Certificate(cert).checkHost("halinka-proxy")).toBe("halinka-proxy");
  });

  it("makes a certificate that is not a CA", () => {
    const { cert } = createProxyCertificate("halinka-proxy");

    expect(new X509Certificate(cert).ca).toBe(false);
  });

  it("makes a positive serial number without a leading zero byte", () => {
    const { cert } = createProxyCertificate("halinka-proxy");

    expect(new X509Certificate(cert).serialNumber).toMatch(/^[4-7][0-9A-F]{31}$/);
  });

  it("makes the certificate of its key", () => {
    const { key, cert } = createProxyCertificate("halinka-proxy");
    const certificate = new X509Certificate(cert);

    expect(certificate.checkPrivateKey(createPrivateKey(key))).toBe(true);
  });

  it("lets a client that trusts the certificate connect", async () => {
    const pair = createProxyCertificate("halinka-proxy");

    expect(await handshake(pair, pair.cert, "halinka-proxy")).toBe("hello");
  });

  it("refuses a client that trusts another certificate", async () => {
    const pair = createProxyCertificate("halinka-proxy");
    const other = createProxyCertificate("halinka-proxy");

    expect(await handshake(pair, other.cert, "halinka-proxy")).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
  });

  it("refuses a client that asks for another host name", async () => {
    const pair = createProxyCertificate("halinka-proxy");

    expect(await handshake(pair, pair.cert, "other-host")).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
  });
});
