import type { AgentStart } from "@halinka/agents/acp";
import type { AgentPreset } from "@halinka/presets";
import { type Credential, proxyRouteUrl, proxyTlsRouteUrl } from "@halinka/sandbox/devcontainer";

// What the runner lends: the proxy adds `credential`, and the agent gets `env` in its place.
export type LentCredential = {
  name: string;
  credential: Credential;
  env: Record<string, string>;
  isLogin: boolean;
};

const writeCodexFiles = `home="\${CODEX_HOME:-$HOME/.codex}" && mkdir -p "$home" && printf '%s' "$HALINKA_CODEX_CONFIG" > "$home/config.toml" && { [ -z "$HALINKA_CODEX_AUTH" ] || (umask 077 && printf '%s' "$HALINKA_CODEX_AUTH" > "$home/auth.json"); } && { [ -z "$HALINKA_PROXY_CA" ] || { printf '%s' "$HALINKA_PROXY_CA" > "$home/proxy-ca.pem" && export CODEX_CA_CERTIFICATE="$home/proxy-ca.pem"; }; } && exec "$@"`;

// The proxy cannot lend a credential to a WebSocket, which the default provider tries first.
const codexConfig = (topLines: string[], providerLines: string[]) =>
  [
    'model_provider = "halinka"',
    ...topLines,
    "",
    "[model_providers.halinka]",
    'name = "OpenAI"',
    ...providerLines,
    "supports_websockets = false",
    "",
  ].join("\n");

const codexApiKeyConfig = (routeUrl: string, envKey: string) =>
  codexConfig([], [`base_url = "${routeUrl}/v1"`, `env_key = "${envKey}"`]);

// So Codex reads the placeholder login and never a keyring.
const codexLoginConfig = (routeUrl: string) =>
  codexConfig(
    [`chatgpt_base_url = "${routeUrl}/backend-api/"`, 'cli_auth_credentials_store = "file"'],
    [`base_url = "${routeUrl}/backend-api/codex"`, "requires_openai_auth = true"],
  );

// `lent` holds only the credentials of this preset, and only logins when it has a login.
export const containerLaunch = (
  preset: AgentPreset,
  lent: LentCredential[],
  proxyCa: string,
): AgentStart => {
  const { command, providerHosts, baseUrl, login } = preset;
  const [first] = lent;
  if (!first) return { command, launch: { providerHosts } };
  const { route, codexFile, hidden } =
    first.isLogin && login
      ? {
          route: login.route,
          codexFile: codexLoginConfig,
          hidden: [new URL(login.refresh.url).hostname],
        }
      : {
          route: preset.route,
          codexFile: (url: string) => codexApiKeyConfig(url, first.name),
          hidden: [] as string[],
        };
  const url = (route.tls ? proxyTlsRouteUrl : proxyRouteUrl)(route.prefix);
  const isCodex = baseUrl === "codex-config";
  const baseUrlEnv = isCodex
    ? { HALINKA_CODEX_CONFIG: codexFile(url) }
    : { [baseUrl.variable]: url };
  const trustEnv = route.tls ? { HALINKA_PROXY_CA: proxyCa } : {};
  return {
    command: isCodex ? ["sh", "-c", writeCodexFiles, "codex", ...command] : command,
    launch: {
      providerHosts: providerHosts.filter((host) => !hidden.includes(host)),
      credentialNames: lent.map(({ name }) => name),
      env: Object.assign({}, ...lent.map(({ env }) => env), baseUrlEnv, trustEnv),
    },
  };
};
