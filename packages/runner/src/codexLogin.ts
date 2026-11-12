import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";

import { agentPresets } from "@halinka/presets";
import { errnoCode } from "@halinka/utils/errors";
import { FileLocks } from "@halinka/utils/fileLocks";
import { ensureFolder, readTextFile, replaceFile } from "@halinka/utils/fs";

export type CodexLogin = {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
};

type Fields = Partial<Record<keyof CodexLogin, unknown>>;

const authClaim = "https://api.openai.com/auth";

// So Codex in the container never refreshes the placeholder.
const placeholderExpiry = Date.UTC(2100, 0, 1);

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

const claimsOf = (token: string): Record<string, unknown> => {
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
    );
    if (claims && typeof claims === "object") return claims as Record<string, unknown>;
  } catch {}
  return {};
};

const accountOf = (idToken: string) => {
  const account = claimsOf(idToken)[authClaim] as Record<string, unknown> | undefined;
  if (!isText(account?.chatgpt_account_id)) return undefined;
  const { chatgpt_account_id, chatgpt_plan_type, chatgpt_user_id } = account;
  return { chatgpt_account_id, chatgpt_plan_type, chatgpt_user_id };
};

const isComplete = (fields: Fields): fields is CodexLogin =>
  [fields.idToken, fields.accessToken, fields.refreshToken, fields.accountId].every(isText);

// Codex skips a login whose account id is not the account of its id token.
const isReadable = ({ idToken, accessToken, accountId }: CodexLogin) =>
  accountOf(idToken)?.chatgpt_account_id === accountId &&
  typeof claimsOf(accessToken).exp === "number";

const loginsFolder = (home: string) => join(home, "logins");

// Codex access tokens live 10 days.
const assumedLifetimeMs = 10 * 86_400_000;

const refreshShare = 0.8;

const codexLoginPath = (home: string) => join(loginsFolder(home), "codex.json");

export const parseCodexAuth = (text: string): CodexLogin => {
  let auth: { tokens?: Record<string, unknown> | null } | null;
  try {
    auth = JSON.parse(text) as typeof auth;
  } catch {
    throw new Error("The Codex auth.json is not JSON.");
  }
  const { id_token, access_token, refresh_token, account_id } = auth?.tokens ?? {};
  const login: Fields = {
    idToken: id_token,
    accessToken: access_token,
    refreshToken: refresh_token,
    accountId: account_id,
  };
  if (!isComplete(login)) {
    throw new Error(
      "The Codex auth.json has no complete ChatGPT login. Log in with ChatGPT, not an API key.",
    );
  }
  if (!isReadable(login)) {
    throw new Error("Halinka cannot read the account of the ChatGPT login in the Codex auth.json.");
  }
  return login;
};

export const readCodexLogin = async (home: string): Promise<CodexLogin | undefined> => {
  const path = codexLoginPath(home);
  const text = await readTextFile(path);
  if (text === undefined) return undefined;
  let fields: Fields | undefined;
  try {
    fields = (JSON.parse(text) as Fields | null) ?? undefined;
  } catch {}
  if (!fields || !isComplete(fields) || !isReadable(fields)) {
    throw new Error(`Halinka cannot read the login in ${path}. Run: halinka agent login codex`);
  }
  const { idToken, accessToken, refreshToken, accountId } = fields;
  return { idToken, accessToken, refreshToken, accountId };
};

// One instance per process: the tasks of one instance wait without a read of the lock file.
export const codexLoginLocks = (home: string) => new FileLocks(loginsFolder(home), randomUUID());

// A refresh and a login save must not both use one refresh token.
export const withCodexLoginLock = async <T>(
  locks: FileLocks,
  task: () => Promise<T>,
  { signal, onWait }: { signal?: AbortSignal; onWait?: (holderPid: number) => void } = {},
): Promise<T> => {
  const release = await locks.take("codex", signal, onWait);
  try {
    signal?.throwIfAborted();
    return await task();
  } finally {
    await release();
  }
};

export const saveCodexLogin = async (home: string, login: CodexLogin) => {
  const path = codexLoginPath(home);
  const folder = dirname(path);
  await ensureFolder(folder);
  await chmod(folder, 0o700);
  await replaceFile(path, `${JSON.stringify(login, null, 2)}\n`, 0o600);
  return path;
};

// Codex never checks the signature.
const unsignedToken = (claims: object) =>
  [{ alg: "none", typ: "JWT" }, claims]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .concat("halinka")
    .join(".");

export const codexPlaceholder = (login: CodexLogin) => {
  const token = unsignedToken({
    [authClaim]: accountOf(login.idToken),
    exp: placeholderExpiry / 1000,
  });
  const auth = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: token,
      access_token: token,
      refresh_token: "halinka-placeholder",
      account_id: login.accountId,
    },
    last_refresh: new Date(placeholderExpiry).toISOString(),
  };
  return { token, authJson: JSON.stringify(auth) };
};

const timesOf = ({ accessToken }: CodexLogin) => {
  const { iat, exp } = claimsOf(accessToken);
  const expiry = (exp as number) * 1000;
  return { expiry, issued: typeof iat === "number" ? iat * 1000 : expiry - assumedLifetimeMs };
};

export const expiryOf = (login: CodexLogin) => timesOf(login).expiry;

export const refreshTimeOf = (login: CodexLogin) => {
  const { expiry, issued } = timesOf(login);
  return issued + (expiry - issued) * refreshShare;
};

// The refresh token is reused, revoked or expired.
export class CodexLoginRejected extends Error {}

type RefreshOptions = { signal?: AbortSignal; fetch?: typeof fetch };

// The `error` of an OAuth answer, as text or as `{ code }`. The read also frees the connection.
const readErrorCode = async (response: Response) => {
  const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
  const { error } = body ?? {};
  if (isText(error)) return error;
  const code = errnoCode(error);
  return isText(code) ? code : undefined;
};

export const refreshCodexLogin = async (
  login: CodexLogin,
  { signal, fetch = globalThis.fetch }: RefreshOptions = {},
): Promise<CodexLogin> => {
  const { url, clientId, scope } = agentPresets.codex.login!.refresh;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: login.refreshToken,
      scope,
    }),
    signal,
  });
  const host = new URL(url).hostname;
  if (!response.ok) {
    const code = await readErrorCode(response);
    const answer = `${host} answered ${response.status}${code ? ` (${code})` : ""}.`;
    // RFC 6749: only `invalid_grant` tells that the token is bad; OpenAI also answers 401.
    if (response.status === 401 || code === "invalid_grant") {
      throw new CodexLoginRejected(`${answer} Run: halinka agent login codex`);
    }
    throw new Error(answer);
  }
  const tokens = (await response.json()) as Record<string, unknown>;
  const refreshed: CodexLogin = {
    idToken: isText(tokens.id_token) ? tokens.id_token : login.idToken,
    accessToken: isText(tokens.access_token) ? tokens.access_token : login.accessToken,
    refreshToken: isText(tokens.refresh_token) ? tokens.refresh_token : login.refreshToken,
    accountId: login.accountId,
  };
  // The server rotated the token already, so a retry cannot use the earlier one.
  if (!isReadable(refreshed)) {
    throw new CodexLoginRejected(
      `${host} gave a login of another account, or without an expiry. Run: halinka agent login codex`,
    );
  }
  return refreshed;
};
