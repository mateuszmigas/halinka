import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it, vi } from "vitest";

import {
  type CodexLogin,
  CodexLoginRejected,
  codexLoginLocks,
  codexPlaceholder,
  parseCodexAuth,
  readCodexLogin,
  refreshCodexLogin,
  refreshTimeOf,
  saveCodexLogin,
  withCodexLoginLock,
} from "./codexLogin";
import { claimsOf, testAccount, testCodexLogin, testIdToken, testToken } from "./testing";

const login = testCodexLogin();

const tokens = {
  id_token: login.idToken,
  access_token: login.accessToken,
  refresh_token: login.refreshToken,
  account_id: login.accountId,
};

describe("codexLogin", () => {
  it("keeps only the ChatGPT login of a Codex auth.json", () => {
    const auth = { auth_mode: "chatgpt", OPENAI_API_KEY: "sk-real", tokens, last_refresh: "x" };

    expect(parseCodexAuth(JSON.stringify(auth))).toEqual(login);
  });

  it.each([
    ["without tokens", { OPENAI_API_KEY: "sk-real", tokens: null }],
    ["with an empty refresh token", { tokens: { ...tokens, refresh_token: "" } }],
    ["without an account id", { tokens: { ...tokens, account_id: undefined } }],
  ])("refuses an auth.json %s", (_, auth) => {
    expect(() => parseCodexAuth(JSON.stringify(auth))).toThrow("has no complete ChatGPT login");
  });

  it.each([
    ["an id token without the account", { ...tokens, id_token: testToken({ email: "a@b.c" }) }],
    ["an access token without an expiry", { ...tokens, access_token: testToken({}) }],
    ["a token that is not a JWT", { ...tokens, id_token: "not-a-token" }],
    ["an account id of another account", { ...tokens, account_id: "account-2" }],
  ])("refuses an auth.json with %s", (_, auth) => {
    expect(() => parseCodexAuth(JSON.stringify({ tokens: auth }))).toThrow(
      "Halinka cannot read the account",
    );
  });

  it("refuses an auth.json that is not JSON", () => {
    expect(() => parseCodexAuth("{")).toThrow("The Codex auth.json is not JSON.");
  });

  it("saves the login for the owner only", async () => {
    const path = await saveCodexLogin(await tempFolder(), login);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("gives the logins folder to the owner only", async () => {
    const home = await tempFolder();
    await mkdir(join(home, "logins"), { mode: 0o755 });

    const path = await saveCodexLogin(home, login);

    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
  });

  it("replaces a saved login", async () => {
    const home = await tempFolder();
    await saveCodexLogin(home, login);

    const path = await saveCodexLogin(home, testCodexLogin("2"));

    const saved = JSON.parse(await readFile(path, "utf8")) as CodexLogin;
    expect(saved.accessToken).toBe(testCodexLogin("2").accessToken);
  });

  it("runs a task with the login lock after the task that holds it", async () => {
    const home = await tempFolder();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const order: string[] = [];
    const first = withCodexLoginLock(codexLoginLocks(home), async () => {
      started.resolve();
      await finish.promise;
      order.push("first");
    });
    await started.promise;
    const second = withCodexLoginLock(codexLoginLocks(home), async () => order.push("second"));

    finish.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual(["first", "second"]);
  });

  it("tells the pid of the process that holds the login lock", async () => {
    const home = await tempFolder();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const holding = withCodexLoginLock(codexLoginLocks(home), () => {
      started.resolve();
      return finish.promise;
    });
    await started.promise;
    const onWait = vi.fn();

    const waiting = withCodexLoginLock(codexLoginLocks(home), async () => {}, { onWait });

    await vi.waitFor(() => expect(onWait).toHaveBeenCalledWith(process.pid));
    finish.resolve();
    await Promise.all([holding, waiting]);
  });

  it("releases the login lock after a task that failed", async () => {
    const home = await tempFolder();
    const locks = codexLoginLocks(home);
    await expect(
      withCodexLoginLock(locks, async () => {
        throw new Error("refresh failed");
      }),
    ).rejects.toThrow("refresh failed");

    await expect(locks.tryTake("codex")).resolves.toBeTypeOf("function");
  });

  it("reads a saved login", async () => {
    const home = await tempFolder();
    await saveCodexLogin(home, login);

    expect(await readCodexLogin(home)).toEqual(login);
  });

  it("reads no login when none is saved", async () => {
    expect(await readCodexLogin(await tempFolder())).toBeUndefined();
  });

  it.each([
    ["that is not JSON", "{"],
    ["without a refresh token", JSON.stringify({ ...login, refreshToken: undefined })],
    ["with a token that is not a JWT", JSON.stringify({ ...login, idToken: "not-a-token" })],
  ])("refuses a saved login %s", async (_, text) => {
    const home = await tempFolder();
    const path = await saveCodexLogin(home, login);
    await writeFile(path, text);

    await expect(readCodexLogin(home)).rejects.toThrow("Run: halinka agent login codex");
  });

  it("gives the container a token with only the account claims", () => {
    const { authJson } = codexPlaceholder(login);

    const { tokens: placeholder } = JSON.parse(authJson) as { tokens: typeof tokens };
    expect(claimsOf(placeholder.access_token)).toEqual({
      "https://api.openai.com/auth": testAccount,
      exp: Date.UTC(2100, 0, 1) / 1000,
    });
  });

  it("gives the container no real token", () => {
    const { authJson } = codexPlaceholder(login);

    for (const token of [login.idToken, login.accessToken, login.refreshToken]) {
      expect(authJson).not.toContain(token);
    }
  });

  it("refreshes at 80 % of the lifetime of the access token", () => {
    const login = testCodexLogin("1", { iat: 1_000_000, exp: 1_000_000 + 10 * 86_400 });

    expect(refreshTimeOf(login)).toBe((1_000_000 + 8 * 86_400) * 1000);
  });

  it("refreshes 2 days before the expiry of a token without iat", () => {
    const login = testCodexLogin("1", { exp: 2_000_000 });

    expect(refreshTimeOf(login)).toBe((2_000_000 - 2 * 86_400) * 1000);
  });

  const refreshWith = (response: Response) => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => response);
    const refreshing = refreshCodexLogin(login, {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    return { fetch, refreshing };
  };

  it("sends the refresh token with the client id of Codex", async () => {
    const { fetch, refreshing } = refreshWith(Response.json({}));
    await refreshing;

    const [url, init] = fetch.mock.calls[0]!;
    expect({ url, body: JSON.parse(init.body as string) }).toEqual({
      url: "https://auth.openai.com/oauth/token",
      body: {
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        grant_type: "refresh_token",
        refresh_token: login.refreshToken,
        scope: "openid profile email",
      },
    });
  });

  it("keeps the tokens that the refresh response omits", async () => {
    const accessToken = testToken({ exp: 1_900_000_000 });
    const { refreshing } = refreshWith(Response.json({ access_token: accessToken }));

    expect(await refreshing).toEqual({ ...login, accessToken });
  });

  it.each([
    [400, { error: "invalid_grant" }],
    [401, { error: { code: "refresh_token_reused" } }],
  ])("tells that auth.openai.com refused the refresh token (%i)", async (status, body) => {
    const { refreshing } = refreshWith(Response.json(body, { status }));

    await expect(refreshing).rejects.toBeInstanceOf(CodexLoginRejected);
  });

  it("tells a request that auth.openai.com did not accept apart from a refused token", async () => {
    const { refreshing } = refreshWith(
      Response.json({ error: "unsupported_grant_type" }, { status: 400 }),
    );

    await expect(refreshing).rejects.toThrow(
      "auth.openai.com answered 400 (unsupported_grant_type).",
    );
  });

  it("tells a failed refresh apart from a refused one", async () => {
    const { refreshing } = refreshWith(new Response("", { status: 503 }));

    await expect(refreshing).rejects.toThrow("auth.openai.com answered 503.");
  });

  it("refuses a refreshed login of another account", async () => {
    const otherAccount = { ...testAccount, chatgpt_account_id: "account-2" };
    const { refreshing } = refreshWith(Response.json({ id_token: testIdToken(otherAccount) }));

    await expect(refreshing).rejects.toBeInstanceOf(CodexLoginRejected);
  });
});
