import { protocolVersion } from "@halinka/protocol";
import { fakeTimers } from "@halinka/utils/testing";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { ServerSettings } from "./serverSettings";
import { stubNpmRegistry } from "./testing";
import { UpdateCheck } from "./updateCheck";

const rowWith = (updateCheck: boolean) => ({
  id: 1,
  updateCheck,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const settingsWith = (updateCheck: boolean) => new ServerSettings(rowWith(updateCheck));

const answerOf = (latest: object) => () => Response.json(latest);

const checked = async (
  latest: object,
  { currentVersion = "1.2.3", settings = settingsWith(true) } = {},
) => {
  stubNpmRegistry(answerOf(latest));
  const check = new UpdateCheck(currentVersion, "server", settings);
  await check.check();
  return check;
};

const spyOnErrors = () => vi.spyOn(console, "error").mockImplementation(() => {});

const pendingRegistry = () =>
  stubNpmRegistry().mockImplementation(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal!;
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
  );

describe("UpdateCheck", () => {
  it("gives a newer version from the npm registry", async () => {
    const check = await checked({ version: "1.3.0", protocolVersion });

    expect(check.status).toEqual({
      latestVersion: "1.3.0",
      isProtocolChange: false,
      command: "server",
    });
  });

  it.each([
    ["1.2.4", "1.2.3"],
    ["1.3.0", "1.2.9"],
    ["2.0.0", "1.9.9"],
    ["1.10.0", "1.9.0"],
  ])("finds %s newer than %s", async (version, currentVersion) => {
    const check = await checked({ version, protocolVersion }, { currentVersion });

    expect(check.status?.latestVersion).toBe(version);
  });

  it.each([
    ["1.2.3", "1.2.3"],
    ["1.2.2", "1.2.3"],
    ["2.0.0-beta.1", "1.2.3"],
    ["2.0.0", "1.2.3-dev"],
  ])("gives no update for %s on a server of %s", async (version, currentVersion) => {
    const check = await checked({ version, protocolVersion }, { currentVersion });

    expect(check.status).toBeUndefined();
  });

  it("names a protocol change", async () => {
    const check = await checked({ version: "1.3.0", protocolVersion: protocolVersion + 1 });

    expect(check.status?.isProtocolChange).toBe(true);
  });

  it("finds no protocol change in a version without the field", async () => {
    const check = await checked({ version: "1.3.0" });

    expect(check.status?.isProtocolChange).toBe(false);
  });

  it("keeps the last version when the registry fails", async () => {
    const check = await checked({ version: "1.3.0", protocolVersion });
    stubNpmRegistry(() => new Response("Not found", { status: 404 }));
    const errors = spyOnErrors();

    await check.check();

    expect(check.status?.latestVersion).toBe("1.3.0");
    expect(errors).toHaveBeenCalledWith("The update check failed: The npm registry answered 404");
  });

  it("keeps the last version after an answer of another shape", async () => {
    const check = await checked({ version: "1.3.0", protocolVersion });
    stubNpmRegistry(answerOf({ name: "halinka" }));
    const errors = spyOnErrors();

    await check.check();

    expect(check.status?.latestVersion).toBe("1.3.0");
    expect(errors).toHaveBeenCalledOnce();
  });

  it("sends no request when the update check is off", async () => {
    const fetch = stubNpmRegistry();
    const check = new UpdateCheck("1.2.3", "server", settingsWith(false));

    await check.check();

    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends one request at a time", async () => {
    const fetch = stubNpmRegistry();
    const check = new UpdateCheck("1.2.3", "server", settingsWith(true));

    await Promise.all([check.check(), check.check()]);

    expect(fetch).toHaveBeenCalledOnce();
  });

  it("checks again after 24 hours", async () => {
    fakeTimers();
    const fetch = stubNpmRegistry();
    const check = new UpdateCheck("1.2.3", "server", settingsWith(true));
    check.start();
    onTestFinished(() => check.stop());

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("checks no more after a stop", async () => {
    fakeTimers();
    const fetch = stubNpmRegistry();
    const check = new UpdateCheck("1.2.3", "server", settingsWith(true));
    check.start();
    await check.stop();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    expect(fetch).toHaveBeenCalledOnce();
  });

  it("forgets the version when the update check goes off", async () => {
    const settings = settingsWith(true);
    const check = await checked({ version: "1.3.0", protocolVersion }, { settings });
    settings.set(rowWith(false));

    await check.settingChanged();

    expect(check.status).toBeUndefined();
  });

  it("forgets the answer of a request that the update check stopped when it went off", async () => {
    const settings = settingsWith(true);
    const check = await checked({ version: "1.3.0", protocolVersion }, { settings });
    const fetch = pendingRegistry();
    void check.check();
    settings.set(rowWith(false));

    await check.settingChanged();

    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(check.status).toBeUndefined();
  });

  it("starts no request after a stop", async () => {
    const fetch = stubNpmRegistry();
    const check = new UpdateCheck("1.2.3", "server", settingsWith(true));
    const changing = check.settingChanged();

    await check.stop();
    await changing;

    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops a request that has not ended", async () => {
    const fetch = pendingRegistry();
    const check = new UpdateCheck("1.2.3", "server", settingsWith(true));
    void check.check();

    await check.stop();

    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("logs nothing for a stopped request", async () => {
    pendingRegistry();
    const errors = spyOnErrors();
    const check = new UpdateCheck("1.2.3", "server", settingsWith(true));
    void check.check();

    await check.stop();

    expect(errors).not.toHaveBeenCalled();
  });
});
