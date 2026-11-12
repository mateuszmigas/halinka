import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { type AgentPreset, agentPresets } from "@halinka/presets";
import { pathExists } from "@halinka/utils/fs";
import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it } from "vitest";

import { codexPlaceholder } from "./codexLogin";
import { Credentials } from "./credentials";
import { testCodexLogin } from "./testing";

const login = testCodexLogin();
const proxyCa = "-----BEGIN CERTIFICATE-----\nproxy\n-----END CERTIFICATE-----\n";

type LaunchOptions = { hasLogin?: boolean };

type RunCodexOptions = LaunchOptions & { agent?: string[] };

const launchOf = (
  preset: AgentPreset,
  env: Record<string, string>,
  { hasLogin = false }: LaunchOptions = {},
) => {
  const credentials = new Credentials(env, { proxyCa });
  if (hasLogin) credentials.setCodexLogin(login);
  return credentials.launch(preset);
};

// Runs the launch with `agent` in place of Codex, in a new CODEX_HOME.
const runCodex = async (
  env: Record<string, string>,
  { hasLogin = false, agent = ["echo", "started"] }: RunCodexOptions = {},
) => {
  const codexHome = await tempFolder();
  const preset = { ...agentPresets.codex, command: agent };
  const { command, launch } = launchOf(preset, env, { hasLogin });
  const output = String(
    execFileSync(command[0]!, command.slice(1), {
      env: { ...launch.env, HOME: await tempFolder(), CODEX_HOME: codexHome },
    }),
  );
  return { codexHome, output };
};

describe("the launch of an agent", () => {
  it("gives the agent placeholders and the route as its base URL", () => {
    const { launch } = launchOf(agentPresets["claude-code"], {
      ANTHROPIC_API_KEY: "sk-ant-api03-real",
    });

    expect(launch.env).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-api03-halinka-placeholder",
      ANTHROPIC_BASE_URL: "http://halinka-proxy:3128/anthropic",
    });
  });

  it("lends the agent the credentials of the environment", () => {
    const { launch } = launchOf(agentPresets["claude-code"], {
      ANTHROPIC_API_KEY: "sk-ant-api03-real",
    });

    expect(launch.credentialNames).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("starts an agent without credentials as it is", () => {
    const preset = agentPresets["claude-code"];

    expect(launchOf(preset, {})).toEqual({
      command: preset.command,
      launch: { providerHosts: preset.providerHosts },
    });
  });

  it("starts Codex after it writes the config", async () => {
    const { output } = await runCodex({ CODEX_API_KEY: "sk-real-key" });

    expect(output).toBe("started\n");
  });

  it("writes a Codex provider of the route for an API key", async () => {
    const { codexHome } = await runCodex({ CODEX_API_KEY: "sk-real-key" });

    expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe(
      [
        'model_provider = "halinka"',
        "",
        "[model_providers.halinka]",
        'name = "OpenAI"',
        'base_url = "http://halinka-proxy:3128/openai/v1"',
        'env_key = "CODEX_API_KEY"',
        "supports_websockets = false",
        "",
      ].join("\n"),
    );
  });

  it("writes no Codex login for an API key", async () => {
    const { codexHome } = await runCodex({ CODEX_API_KEY: "sk-real-key" });

    expect(await pathExists(join(codexHome, "auth.json"))).toBe(false);
  });

  it("gives Codex with an API key no proxy certificate", async () => {
    const { output } = await runCodex(
      { CODEX_API_KEY: "sk-real-key" },
      {
        agent: ["sh", "-c", 'printf "%s" "$CODEX_CA_CERTIFICATE"'],
      },
    );

    expect(output).toBe("");
  });

  it("writes the Codex config in $HOME/.codex without CODEX_HOME", async () => {
    const home = await tempFolder();
    const { command, launch } = launchOf(
      { ...agentPresets.codex, command: ["echo", "started"] },
      { CODEX_API_KEY: "sk-real-key" },
    );

    execFileSync(command[0]!, command.slice(1), { env: { ...launch.env, HOME: home } });

    expect(await pathExists(join(home, ".codex", "config.toml"))).toBe(true);
  });

  it("writes the placeholder login of Codex", async () => {
    const { codexHome } = await runCodex({}, { hasLogin: true });

    expect(await readFile(join(codexHome, "auth.json"), "utf8")).toBe(
      codexPlaceholder(login).authJson,
    );
  });

  it("writes the placeholder login for its owner only", async () => {
    const { codexHome } = await runCodex({}, { hasLogin: true });

    expect((await stat(join(codexHome, "auth.json"))).mode & 0o777).toBe(0o600);
  });

  it("writes a Codex provider of the ChatGPT route for a login", async () => {
    const { codexHome } = await runCodex({}, { hasLogin: true });

    expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe(
      [
        'model_provider = "halinka"',
        'chatgpt_base_url = "https://halinka-proxy/chatgpt/backend-api/"',
        'cli_auth_credentials_store = "file"',
        "",
        "[model_providers.halinka]",
        'name = "OpenAI"',
        'base_url = "https://halinka-proxy/chatgpt/backend-api/codex"',
        "requires_openai_auth = true",
        "supports_websockets = false",
        "",
      ].join("\n"),
    );
  });

  it("gives Codex with a login the certificate of the proxy", async () => {
    const { codexHome, output } = await runCodex(
      {},
      {
        hasLogin: true,
        agent: ["sh", "-c", 'printf "%s" "$CODEX_CA_CERTIFICATE"'],
      },
    );

    expect(await readFile(output, "utf8")).toBe(proxyCa);
    expect(output).toBe(join(codexHome, "proxy-ca.pem"));
  });

  it("asks Codex for the ChatGPT login", () => {
    const { launch } = launchOf(agentPresets.codex, {}, { hasLogin: true });

    expect(launch.env?.DEFAULT_AUTH_REQUEST).toBe('{"methodId":"chat-gpt"}');
  });

  it("gives Codex with a login no route to the hosts that refresh it", () => {
    const { launch } = launchOf(agentPresets.codex, {}, { hasLogin: true });

    expect(launch.providerHosts).toEqual(["api.openai.com", "chatgpt.com"]);
  });

  it("launches Codex with the login and not the API key", () => {
    const { launch } = launchOf(
      agentPresets.codex,
      { CODEX_API_KEY: "sk-real-key" },
      { hasLogin: true },
    );

    expect(launch.credentialNames).toEqual(["CODEX_LOGIN"]);
  });
});
