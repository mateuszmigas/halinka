import { type AgentPreset, type AgentPresetId, agentPresets } from "@halinka/presets";
import type { StoredCredential } from "@halinka/protocol";
import type { Credential } from "@halinka/sandbox/devcontainer";

import { containerLaunch, type LentCredential } from "./agentLaunch";
import { type CodexLogin, codexPlaceholder, expiryOf } from "./codexLogin";
import { LentValues } from "./lentValues";

type Environment = Record<string, string | undefined>;

type Entry = LentCredential & { preset: AgentPresetId };

// `proxyCa` is the certificate of the proxy, which an agent trusts for a route over TLS.
export type CredentialsOptions = { proxyCa?: string };

const withScheme = (scheme: string | undefined, text: string) =>
  scheme ? `${scheme} ${text}` : text;

export const codexLoginName = "CODEX_LOGIN";

const tokensOf = (login: CodexLogin) => [login.accessToken, login.refreshToken, login.idToken];

const isSameLogin = (a: CodexLogin, b: CodexLogin) =>
  a.accessToken === b.accessToken &&
  a.refreshToken === b.refreshToken &&
  a.idToken === b.idToken &&
  a.accountId === b.accountId;

const proxyValues = (entries: Entry[]) =>
  Object.fromEntries(entries.map(({ name, credential }) => [name, credential]));

export type ProxyCredentials = { forProxy: () => Record<string, Credential> };

export class Credentials {
  readonly lent = new LentValues();
  private readonly entries = new Map<string, Entry>();
  private readonly proxyCa: string;
  private earlierCodexLogins: CodexLogin[] = [];
  private codexLogin?: { login: CodexLogin; placeholder: ReturnType<typeof codexPlaceholder> };

  constructor(env: Environment, { proxyCa = "" }: CredentialsOptions = {}) {
    this.proxyCa = proxyCa;
    for (const preset of Object.values(agentPresets)) {
      for (const entry of this.lend(preset, env)) this.entries.set(entry.name, entry);
    }
  }

  lend(preset: AgentPreset, values: Environment): Entry[] {
    const { id, credentials, route } = preset;
    return credentials.flatMap(({ variable, header, scheme, placeholder }) => {
      const value = values[variable];
      if (!value) return [];
      // Without the scheme, so a value printed alone is masked too.
      this.lent.add(variable, value);
      return {
        preset: id,
        name: variable,
        credential: {
          ...route,
          header,
          placeholder: withScheme(scheme, placeholder),
          value: withScheme(scheme, value),
        },
        env: { [variable]: placeholder },
        isLogin: false,
      };
    });
  }

  newScope() {
    return new CredentialScope(this);
  }

  // Keyed by the names that `launch` grants.
  forProxy(): Record<string, Credential> {
    return proxyValues([...this.entries.values()]);
  }

  // `stored` replaces the values of the runner.
  launch(preset: AgentPreset, stored: Entry[] = []) {
    if (stored.length > 0) return containerLaunch(preset, stored, this.proxyCa);
    const lent = [...this.entries.values()].filter((entry) => entry.preset === preset.id);
    const logins = lent.filter((entry) => entry.isLogin);
    return containerLaunch(preset, logins.length > 0 ? logins : lent, this.proxyCa);
  }

  // The same account keeps its placeholder: a running step uses the auth.json of its start.
  setCodexLogin(login: CodexLogin) {
    const current = this.codexLogin;
    if (current && isSameLogin(current.login, login)) return false;
    const { prefix, origin, paths } = agentPresets.codex.login!.route;
    for (const token of tokensOf(login)) this.lent.add(codexLoginName, token);
    if (current) this.earlierCodexLogins.push(current.login);
    this.forgetExpiredCodexLogins(login);
    const placeholder =
      current?.login.accountId === login.accountId ? current.placeholder : codexPlaceholder(login);
    this.codexLogin = { login, placeholder };
    const { token, authJson } = placeholder;
    this.entries.set(codexLoginName, {
      preset: "codex",
      name: codexLoginName,
      credential: {
        prefix,
        origin,
        paths,
        header: "authorization",
        placeholder: `Bearer ${token}`,
        value: `Bearer ${login.accessToken}`,
      },
      env: {
        HALINKA_CODEX_AUTH: authJson,
        DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: "chat-gpt" }),
      },
      isLogin: true,
    });
    return true;
  }

  // An expired access token opens nothing; a refresh token stays masked: a new login does not end it.
  private forgetExpiredCodexLogins(current: CodexLogin) {
    const kept = new Set(tokensOf(current));
    this.earlierCodexLogins = this.earlierCodexLogins.filter((earlier) => {
      if (expiryOf(earlier) > Date.now()) return true;
      for (const token of [earlier.accessToken, earlier.idToken]) {
        if (!kept.has(token)) this.lent.delete(token);
      }
      return false;
    });
  }
}

// Only the proxy of its owner, a run or an agent test, gets these stored keys.
export class CredentialScope {
  private readonly stored = new Map<AgentPresetId, Entry[]>();

  constructor(private readonly machine: Credentials) {}

  setStored(preset: AgentPreset, stored: StoredCredential[]) {
    const values = Object.fromEntries(stored.map(({ variable, value }) => [variable, value]));
    this.stored.set(preset.id, this.machine.lend(preset, values));
  }

  hasStored(preset: AgentPreset) {
    return this.storedOf(preset).length > 0;
  }

  forProxy(): Record<string, Credential> {
    return { ...this.machine.forProxy(), ...proxyValues([...this.stored.values()].flat()) };
  }

  launch(preset: AgentPreset) {
    return this.machine.launch(preset, this.storedOf(preset));
  }

  private storedOf(preset: AgentPreset) {
    return this.stored.get(preset.id) ?? [];
  }
}
