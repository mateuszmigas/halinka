import { describe, expect, it } from "vitest";

import { parseRepoConfig } from "./repoConfig";
import { createDevcontainer, createRepoConfig, createSmokeWorkflow } from "./repoScaffold";
import { parseWorkflow } from "./workflow";

describe("repoScaffold", () => {
  it("writes a config that the config schema accepts", () => {
    const config = { server: "https://halinka.example.com", devcontainer: ".devcontainer.json" };

    expect(parseRepoConfig(createRepoConfig(config))).toEqual({
      ok: true,
      value: config,
    });
  });

  it("writes no devcontainer key without a devcontainer", () => {
    expect(parseRepoConfig(createRepoConfig({ server: "local" }))).toEqual({
      ok: true,
      value: { server: "local" },
    });
  });

  it("writes a devcontainer with an image", () => {
    expect(JSON.parse(createDevcontainer())).toHaveProperty("image");
  });

  it("writes a smoke workflow that the workflow schema accepts", () => {
    expect(parseWorkflow(createSmokeWorkflow())).toMatchObject({ ok: true });
  });
});
