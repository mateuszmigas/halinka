import { rm, writeFile } from "node:fs/promises";

import { tempFolder, fakeTimers } from "@halinka/utils/testing";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import {
  type CodexLogin,
  codexLoginLocks,
  readCodexLogin,
  saveCodexLogin,
  withCodexLoginLock,
} from "./codexLogin";
import { CodexLogins } from "./codexLogins";
import { Credentials } from "./credentials";
import { claimsOf, testCodexLogin, testIdToken, testToken } from "./testing";

const dayMs = 86_400_000;

const nowSeconds = () => Math.floor(Date.now() / 1000);

const loginIssued = (daysAgo: number, id = "1") =>
  testCodexLogin(id, {
    iat: nowSeconds() - daysAgo * 86_400,
    exp: nowSeconds() + (10 - daysAgo) * 86_400,
  });

const dueLogin = (id = "1") => loginIssued(9, id);

const freshLogin = (id = "1") => loginIssued(0, id);

const expiredLogin = () => loginIssued(11);

const failedRefresh = (reason: string) => `Halinka could not refresh the Codex login: ${reason}`;

const answer = (status: number, body: object = {}) => Response.json(body, { status });

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const refreshedTokens = () => ({
  id_token: testIdToken(),
  access_token: testToken({ iat: nowSeconds(), exp: nowSeconds() + 10 * 86_400, jti: "new" }),
  refresh_token: "refresh-token-new",
});

const setUp = async ({
  fetch = vi.fn<Fetch>(async () => answer(200, refreshedTokens())),
  writePolicies = vi.fn(async () => {}),
  retry = { initialDelayMs: 1, maxDelayMs: 1 },
} = {}) => {
  const home = await tempFolder();
  const credentials = new Credentials({});
  const logins = new CodexLogins({
    home,
    credentials,
    writePolicies,
    fetch: fetch as unknown as typeof globalThis.fetch,
    retry,
  });
  // Before the removal of `home`: a refresh can still hold the lock.
  onTestFinished(() => logins.stop());
  fakeTimers(["setTimeout", "clearTimeout", "Date"]);
  const valueOf = () => credentials.forProxy().CODEX_LOGIN?.value;
  const save = (login: CodexLogin) => saveCodexLogin(home, login);
  const saved = async () => (await readCodexLogin(home))?.refreshToken;
  const startWith = async (login: CodexLogin) => {
    await save(login);
    await logins.read();
    logins.start();
  };
  const lentJti = () => claimsOf(valueOf()?.replace("Bearer ", "") ?? "").jti;
  return { home, logins, valueOf, lentJti, save, saved, startWith, fetch, writePolicies };
};

describe("CodexLogins", () => {
  it("lends the saved login", async () => {
    const { logins, valueOf, save } = await setUp();
    const login = testCodexLogin();
    await save(login);

    await logins.read();

    expect(valueOf()).toBe(`Bearer ${login.accessToken}`);
  });

  it("lends a login that the CLI saves after the start", async () => {
    const { logins, valueOf, save } = await setUp();
    await save(testCodexLogin());
    await logins.read();
    const login = testCodexLogin("2");
    await save(login);

    await logins.read();

    expect(valueOf()).toBe(`Bearer ${login.accessToken}`);
  });

  it("publishes a new login to the proxies", async () => {
    const { logins, save, writePolicies } = await setUp();
    await save(testCodexLogin());

    await logins.read();

    expect(writePolicies).toHaveBeenCalledTimes(1);
  });

  it("publishes nothing when the login is the same", async () => {
    const { logins, save, writePolicies } = await setUp();
    await save(testCodexLogin());
    await logins.read();

    await logins.read();

    expect(writePolicies).toHaveBeenCalledTimes(1);
  });

  it("keeps the login when the file is removed", async () => {
    const { logins, valueOf, save } = await setUp();
    const login = testCodexLogin();
    const path = await save(login);
    await logins.read();
    await rm(path);

    await logins.read();

    expect(valueOf()).toBe(`Bearer ${login.accessToken}`);
  });

  it("refuses a saved login that it cannot read", async () => {
    const { logins, save } = await setUp();
    await writeFile(await save(testCodexLogin()), "{");

    await expect(logins.read()).rejects.toThrow("Run: halinka agent login codex");
  });

  it("reads again after a read that failed", async () => {
    const { logins, valueOf, save } = await setUp();
    await writeFile(await save(testCodexLogin()), "{");
    await logins.read().catch(() => {});
    const login = testCodexLogin("2");
    await save(login);

    await logins.read();

    expect(valueOf()).toBe(`Bearer ${login.accessToken}`);
  });

  it("refreshes no login before its refresh time", async () => {
    const { logins, startWith, fetch } = await setUp();
    await startWith(freshLogin());

    await vi.advanceTimersByTimeAsync(8 * dayMs - 60_000);
    await logins.read();

    expect(fetch).not.toHaveBeenCalled();
  });

  it("saves the refreshed login at its refresh time", async () => {
    const { startWith, saved } = await setUp();
    await startWith(freshLogin());

    await vi.advanceTimersByTimeAsync(8 * dayMs);

    await vi.waitFor(async () => expect(await saved()).toBe("refresh-token-new"));
  });

  it("refreshes a login whose refresh time passed while the machine slept", async () => {
    const { startWith, saved } = await setUp();
    await startWith(freshLogin());

    vi.setSystemTime(Date.now() + 9 * dayMs);
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    await vi.waitFor(async () => expect(await saved()).toBe("refresh-token-new"));
  });

  it("lends the refreshed access token", async () => {
    const { startWith, lentJti } = await setUp();

    await startWith(dueLogin());

    await vi.waitFor(() => expect(lentJti()).toBe("new"));
  });

  it("uses a login that another process refreshed", async () => {
    const { logins, save, valueOf, fetch } = await setUp();
    await save(dueLogin());
    await logins.read();
    const login = freshLogin("2");
    await save(login);

    logins.start();

    await vi.waitFor(() => expect(valueOf()).toBe(`Bearer ${login.accessToken}`));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("tries again after a refresh that failed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi
      .fn<Fetch>(async () => answer(200, refreshedTokens()))
      .mockImplementationOnce(async () => answer(503));
    const { startWith, saved } = await setUp({ fetch });

    await startWith(dueLogin());

    await vi.waitFor(async () => expect(await saved()).toBe("refresh-token-new"));
    expect(error).toHaveBeenCalledWith(failedRefresh("auth.openai.com answered 503."));
  });

  it("waits for the back-off after a failed refresh, also at a Codex start", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn<Fetch>(async () => answer(503));
    const { logins, startWith } = await setUp({
      fetch,
      retry: { initialDelayMs: 60_000, maxDelayMs: 60_000 },
    });
    await startWith(dueLogin());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    await logins.read();
    await vi.advanceTimersByTimeAsync(30_000);
    await logins.read();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(failedRefresh("auth.openai.com answered 503."));
  });

  it("backs off after a refresh that gives no later expiry", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn<Fetch>(async () => answer(200, { refresh_token: "refresh-token-new" }));
    const { logins, startWith } = await setUp({
      fetch,
      retry: { initialDelayMs: 60_000, maxDelayMs: 60_000 },
    });
    await startWith(dueLogin());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    await vi.advanceTimersByTimeAsync(30_000);
    await logins.read();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      failedRefresh("The refresh gave no access token with a later expiry."),
    );
  });

  it("refreshes an expired login once while the back-off runs", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn<Fetch>(async () => answer(503));
    const { logins, save } = await setUp({
      fetch,
      retry: { initialDelayMs: 60_000, maxDelayMs: 60_000 },
    });
    await save(expiredLogin());
    await logins.readForStart().catch(() => {});

    await logins.readForStart().catch(() => {});

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(failedRefresh("auth.openai.com answered 503."));
  });

  it("refreshes an expired login once for two Codex starts at the same time", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn<Fetch>(async () => answer(503));
    const { logins, save } = await setUp({
      fetch,
      retry: { initialDelayMs: 60_000, maxDelayMs: 60_000 },
    });
    await save(expiredLogin());

    await Promise.allSettled([logins.readForStart(), logins.readForStart()]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(failedRefresh("auth.openai.com answered 503."));
  });

  it("refreshes a refused login no more", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn<Fetch>(async () => answer(400, { error: "invalid_grant" }));
    const { logins, startWith } = await setUp({ fetch });
    await startWith(dueLogin());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    await vi.advanceTimersByTimeAsync(dayMs);
    await logins.read();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("auth.openai.com answered 400"));
  });

  it("tells that a refused login needs a new login", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { logins, startWith } = await setUp({ fetch: vi.fn<Fetch>(async () => answer(401)) });

    await startWith(dueLogin());
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    await logins.read();

    expect(error).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Run: halinka agent login codex"),
    );
  });

  it("refreshes a new login after a refused one", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi
      .fn<Fetch>(async () => answer(200, refreshedTokens()))
      .mockImplementationOnce(async () => answer(401));
    const { logins, save, startWith } = await setUp({ fetch });
    await startWith(dueLogin());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    await save(dueLogin("2"));
    await logins.read();

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetch.mock.calls[1]![1].body as string)).toMatchObject({
      refresh_token: "refresh-token-2",
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("auth.openai.com answered 401"));
  });

  it("refreshes nothing after the stop", async () => {
    const { logins, startWith, fetch } = await setUp();
    await startWith(freshLogin());

    await logins.stop();
    await vi.advanceTimersByTimeAsync(9 * dayMs);
    await logins.read();

    expect(fetch).not.toHaveBeenCalled();
  });

  it("saves the refreshed login when the stop comes during the refresh request", async () => {
    const answered = Promise.withResolvers<Response>();
    const fetch = vi.fn<Fetch>(() => answered.promise);
    const { logins, startWith, saved } = await setUp({ fetch });
    await startWith(dueLogin());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    const stopped = logins.stop();
    answered.resolve(answer(200, refreshedTokens()));
    await stopped;

    expect(await saved()).toBe("refresh-token-new");
  });

  it("ends a stop while a refresh waits for the login lock", async () => {
    const { home, logins, startWith } = await setUp();
    const holding = Promise.withResolvers<void>();
    const held = withCodexLoginLock(codexLoginLocks(home), () => holding.promise);
    await startWith(dueLogin());

    await logins.stop();

    holding.resolve();
    await held;
  });

  it("refreshes an expired login at a Codex start", async () => {
    const { logins, save, lentJti } = await setUp();
    await save(expiredLogin());

    await logins.readForStart();

    expect(lentJti()).toBe("new");
  });

  it("refuses a Codex start with an expired login that auth.openai.com refused", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { logins, save } = await setUp({ fetch: vi.fn<Fetch>(async () => answer(401)) });
    await save(expiredLogin());

    await expect(logins.readForStart()).rejects.toThrow("Run: halinka agent login codex");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("auth.openai.com answered 401"));
  });

  it("refuses a Codex start with an expired login whose refresh failed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { logins, save } = await setUp({ fetch: vi.fn<Fetch>(async () => answer(503)) });
    await save(expiredLogin());

    await expect(logins.readForStart()).rejects.toThrow(
      "its refresh failed: auth.openai.com answered 503.",
    );
    expect(error).toHaveBeenCalledWith(failedRefresh("auth.openai.com answered 503."));
  });
});
