import { execFileSync } from "node:child_process";

import type { ProxyCertificate } from "../proxyCertificate";
import { type Credential, type Grant, policyFile, runNetworksOf } from "../runNetwork";

export { runNetworksOf } from "../runNetwork";

// Self-signed for `localhost`, valid until 2126.
export const testKey = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg1C5jt5GkEPR5xDlB
7R8mkJJ2IRETZ49vcnVXgPx8WzuhRANCAASQuO4uIkRX0CNPMubGQhJbXNU9BzqG
GgdfUeEZpjgEsOPZLs5jVr84VHCwjSpAtBHUTb+zLNSuPGJ4yUO9Qhe/
-----END PRIVATE KEY-----
`;

export const testCertificate = `-----BEGIN CERTIFICATE-----
MIIBlDCCATugAwIBAgIUIbm9hFeUXxpZCSadkLckhfIARSAwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyOTEwMTUzOVoYDzIxMjYxMDA1
MTAxNTM5WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAASQuO4uIkRX0CNPMubGQhJbXNU9BzqGGgdfUeEZpjgEsOPZLs5jVr84
VHCwjSpAtBHUTb+zLNSuPGJ4yUO9Qhe/o2kwZzAdBgNVHQ4EFgQUVMXLg7hciZbr
3jNcgsG8Uapm/AQwHwYDVR0jBBgwFoAUVMXLg7hciZbr3jNcgsG8Uapm/AQwDwYD
VR0TAQH/BAUwAwEB/zAUBgNVHREEDTALgglsb2NhbGhvc3QwCgYIKoZIzj0EAwID
RwAwRAIgAyfSkIoLS+PeEpn/vOGigbM+HnqrdtANOZzk537DIqkCIA2rqB5GbfOh
ZyvLIL1PVptK1znVfYvelZbExMHgpvsU
-----END CERTIFICATE-----
`;

export const testCredential = (origin: string): Credential => ({
  prefix: "/anthropic",
  origin,
  paths: ["/v1/messages", "/v1/messages/count_tokens"],
  header: "x-api-key",
  placeholder: "sk-ant-api03-placeholder",
  value: "sk-ant-api03-real",
});

export type ProxyPolicy = {
  tokens: Record<string, Grant>;
  credentials: Record<string, Credential>;
  reachable: string[];
  hostAddresses: string[];
  certificate?: ProxyCertificate;
};

// `undefined` when the proxy of the run network `name` has no policy.
export const readProxyPolicy = (name: string): ProxyPolicy | undefined => {
  const text = execFileSync(
    "docker",
    ["exec", runNetworksOf(name).proxy, "sh", "-c", `cat ${policyFile} 2>/dev/null || true`],
    { encoding: "utf8" },
  );
  return text ? (JSON.parse(text) as ProxyPolicy) : undefined;
};
