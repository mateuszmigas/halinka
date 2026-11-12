import type { ToolNeed } from "@halinka/workflow";

// What the server, the portal, the CLI and the runner know about an agent kind.
export type AgentPresetId = "claude-code" | "codex";

// The proxy lends the credential only on an exact path of `paths`; a client reaches a `tls` route over HTTPS.
export type ProviderRoute = { prefix: string; origin: string; paths: string[]; tls?: boolean };

export type CredentialPreset = {
  variable: string;
  header: string;
  scheme?: "Bearer";
  placeholder: string;
};

// The runner refreshes the login at `refresh.url`; the agent cannot reach its host.
export type LoginRefresh = { url: string; clientId: string; scope: string };

export type LoginPreset = { route: ProviderRoute; refresh: LoginRefresh };

// Codex reads a base URL only from its config file.
export type BaseUrlSetting = { variable: string } | "codex-config";

export type ToolsPreset = {
  needs: Record<string, ToolNeed>;
  sessionMeta: (tools: string[]) => Record<string, unknown>;
};

export type AgentPreset = {
  id: AgentPresetId;
  label: string;
  command: string[];
  // installed in a devcontainer, at an exact version
  package: string;
  version: string;
  credentials: CredentialPreset[];
  route: ProviderRoute;
  baseUrl: BaseUrlSetting;
  providerHosts: string[];
  login?: LoginPreset;
  // its ACP `usage_update` has `cost`
  canReportCost: boolean;
  // it sends `session/request_permission` before it runs a tool
  canAskPermission: boolean;
  env?: Record<string, string>;
  // Absent: the agent cannot take a list of tools.
  tools?: ToolsPreset;
};

export const findAgentPreset = (id: string): AgentPreset | undefined =>
  Object.hasOwn(agentPresets, id) ? agentPresets[id as AgentPresetId] : undefined;

export const packageAt = ({ package: name, version }: AgentPreset, selected = version) =>
  `${name}@${selected}`;

export const agentPresets: Record<AgentPresetId, AgentPreset> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    command: ["claude-agent-acp"],
    package: "@agentclientprotocol/claude-agent-acp",
    version: "0.93.0",
    credentials: [
      {
        variable: "ANTHROPIC_API_KEY",
        header: "x-api-key",
        placeholder: "sk-ant-api03-halinka-placeholder",
      },
      {
        variable: "CLAUDE_CODE_OAUTH_TOKEN",
        header: "authorization",
        scheme: "Bearer",
        placeholder: "sk-ant-oat01-halinka-placeholder",
      },
    ],
    route: {
      prefix: "/anthropic",
      origin: "https://api.anthropic.com",
      paths: ["/v1/messages", "/v1/messages/count_tokens", "/v1/messages/cache_touch"],
    },
    baseUrl: { variable: "ANTHROPIC_BASE_URL" },
    providerHosts: ["api.anthropic.com"],
    canReportCost: true,
    canAskPermission: true,
    tools: {
      needs: {
        Edit: "write",
        MultiEdit: "write",
        NotebookEdit: "write",
        Write: "write",
        Bash: "shell",
        PowerShell: "shell",
        WebFetch: "network",
        WebSearch: "anyHost",
      },
      sessionMeta: (tools) => ({ claudeCode: { options: { tools } } }),
    },
  },
  codex: {
    id: "codex",
    label: "Codex",
    command: ["codex-acp"],
    package: "@agentclientprotocol/codex-acp",
    version: "2.1.1",
    credentials: ["OPENAI_API_KEY", "CODEX_API_KEY"].map((variable) => ({
      variable,
      header: "authorization",
      scheme: "Bearer",
      placeholder: "sk-halinka-placeholder",
    })),
    route: {
      prefix: "/openai",
      origin: "https://api.openai.com",
      paths: ["/v1/responses", "/v1/responses/compact"],
    },
    baseUrl: "codex-config",
    providerHosts: ["api.openai.com", "chatgpt.com", "auth.openai.com"],
    login: {
      // The ChatGPT token also opens the user's conversations and cloud tasks.
      route: {
        prefix: "/chatgpt",
        origin: "https://chatgpt.com",
        paths: [
          "/backend-api/codex/responses",
          "/backend-api/codex/responses/compact",
          "/backend-api/codex/models",
          "/backend-api/codex/memories/trace_summarize",
          "/backend-api/wham/accounts/check",
          "/backend-api/wham/config/bundle",
          "/backend-api/wham/usage",
        ],
        // Codex accepts a ChatGPT backend only over HTTPS.
        tls: true,
      },
      refresh: {
        url: "https://auth.openai.com/oauth/token",
        clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
        scope: "openid profile email",
      },
    },
    // Else the adapter drops a server of the session that has the name of a server in a config file.
    env: { DISABLE_MCP_CONFIG_FILTERING: "true" },
    canReportCost: false,
    canAskPermission: false,
  },
};
