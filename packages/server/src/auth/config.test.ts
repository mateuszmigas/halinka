import { describe, expect, it } from "vitest";

import { authConfigFromEnv } from "./config";

const complete = {
  HALINKA_PUBLIC_URL: "https://halinka.example.com",
  HALINKA_AUTH_SECRET: "s".repeat(32),
  HALINKA_GITHUB_CLIENT_ID: "client",
  HALINKA_GITHUB_CLIENT_SECRET: "secret",
  HALINKA_ADMIN_GITHUB: "octo",
};

describe("authConfigFromEnv", () => {
  it("gives no config when no value is set", () => {
    expect(authConfigFromEnv({})).toBeUndefined();
  });

  it("gives the config when all values are set", () => {
    expect(authConfigFromEnv(complete)).toMatchObject({
      publicUrl: "https://halinka.example.com",
      firstAdminLogin: "octo",
    });
  });

  it("names the values that are missing", () => {
    const { HALINKA_AUTH_SECRET: _, ...partial } = complete;

    expect(() => authConfigFromEnv(partial)).toThrow("Set also HALINKA_AUTH_SECRET, or none");
  });

  it("refuses a short secret", () => {
    expect(() => authConfigFromEnv({ ...complete, HALINKA_AUTH_SECRET: "short" })).toThrow(
      "at least 32 characters",
    );
  });

  it.each(["http://halinka.example.com", "not a url"])("refuses the public URL %s", (url) => {
    expect(() => authConfigFromEnv({ ...complete, HALINKA_PUBLIC_URL: url })).toThrow(
      "must be an https URL",
    );
  });

  it("refuses a public URL with a path", () => {
    const withPath = { ...complete, HALINKA_PUBLIC_URL: "https://halinka.example.com/halinka" };

    expect(() => authConfigFromEnv(withPath)).toThrow("must have no path");
  });

  it("keeps no slash at the end of the public URL", () => {
    const withSlash = { ...complete, HALINKA_PUBLIC_URL: "https://halinka.example.com/" };

    expect(authConfigFromEnv(withSlash)).toMatchObject({
      publicUrl: "https://halinka.example.com",
    });
  });

  it("accepts http on this machine", () => {
    const local = { ...complete, HALINKA_PUBLIC_URL: "http://127.0.0.1:7070" };

    expect(authConfigFromEnv(local)).toMatchObject({ publicUrl: "http://127.0.0.1:7070" });
  });
});
