import { describe, expect, it } from "vitest";

import { parseRepoConfig, secretNameSchema } from "./repoConfig";

const messagesOf = (source: string) => {
  const parsed = parseRepoConfig(source);
  return parsed.ok ? [] : parsed.problems.map(({ message }) => message);
};

describe("parseRepoConfig", () => {
  it("reads the devcontainer", () => {
    expect(
      parseRepoConfig("schema_version: 1\ndevcontainer: .devcontainer/devcontainer.json\n"),
    ).toEqual({
      ok: true,
      value: { devcontainer: ".devcontainer/devcontainer.json" },
    });
  });

  it.each(["/etc/devcontainer.json", "../other/devcontainer.json", ".devcontainer//x.json"])(
    "refuses the devcontainer path %s",
    (path) => {
      expect(messagesOf(`schema_version: 1\ndevcontainer: ${path}\n`)).toEqual([
        "Use a path from the repo root, such as .devcontainer/devcontainer.json",
      ]);
    },
  );

  const withSetup = (...lines: string[]) =>
    [
      "schema_version: 1",
      "devcontainer: dc.json",
      "setup:",
      ...lines.map((line) => `  ${line}`),
    ].join("\n");

  it("reads the setup", () => {
    const source = withSetup(
      "network: [registry.npmjs.org]",
      "run: npm ci",
      "secrets: [NPM_TOKEN]",
    );

    expect(parseRepoConfig(source)).toEqual({
      ok: true,
      value: {
        devcontainer: "dc.json",
        setup: { network: ["registry.npmjs.org"], run: "npm ci", secrets: ["NPM_TOKEN"] },
      },
    });
  });

  it("refuses a host of setup that is not a host name", () => {
    expect(messagesOf(withSetup("network: ['https://example.com']"))).toEqual([
      "Use a host name in lowercase, such as registry.npmjs.org",
    ]);
  });

  it("refuses a secret name that the env file of a command cannot hold", () => {
    expect(secretNameSchema.safeParse("A".repeat(129)).success).toBe(false);
  });

  it("refuses an empty command of setup", () => {
    expect(messagesOf(withSetup("run: '  '"))).toEqual(["Must not be empty"]);
  });

  it("refuses secrets of setup without a command", () => {
    expect(messagesOf(withSetup("secrets: [NPM_TOKEN]"))).toEqual([
      "Only setup.run gets secrets. Add run.",
    ]);
  });

  it("refuses a secret name that is not an environment name", () => {
    expect(messagesOf(withSetup("run: npm ci", "secrets: [npm-token]"))).toEqual([
      "Use capital letters, digits and underscores, such as NPM_TOKEN",
    ]);
  });

  it("refuses setup without a devcontainer", () => {
    expect(messagesOf("schema_version: 1\nsetup:\n  run: npm ci\n")).toEqual([
      "Only a devcontainer has setup. Add devcontainer.",
    ]);
  });

  it("refuses an unknown key", () => {
    expect(messagesOf("schema_version: 1\nextra: {}\n")).toEqual(["Unknown key"]);
  });

  it("gives the reason of environments", () => {
    expect(messagesOf("schema_version: 1\nenvironments: {}\n")).toEqual([
      "A repo has one devcontainer. Write devcontainer: <path> and delete environments.",
    ]);
  });

  it("reads a config with only the version", () => {
    expect(parseRepoConfig("schema_version: 1\n")).toEqual({ ok: true, value: {} });
  });

  it("gives the reason of server", () => {
    expect(messagesOf("schema_version: 1\nserver: local\n")).toEqual([
      "A repo does not select a server. Delete the server key.",
    ]);
  });
});
