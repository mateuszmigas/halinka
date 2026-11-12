import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it, vi } from "vitest";

import { readLogins, updateLogins } from "./logins";

const setUp = async () => {
  vi.stubEnv("HALINKA_HOME", await tempFolder());
};

const withToken = (server: string) => (logins: Awaited<ReturnType<typeof readLogins>>) => ({
  ...logins,
  tokens: { ...logins.tokens, [server]: { token: `token of ${server}`, login: "octo" } },
});

describe("updateLogins", () => {
  it("keeps both of two changes at one time", async () => {
    await setUp();

    await Promise.all([
      updateLogins(withToken("https://a.example.com")),
      updateLogins(withToken("https://b.example.com")),
    ]);

    expect(Object.keys((await readLogins()).tokens).sort()).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });
});
