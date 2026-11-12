import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { pathExists } from "@halinka/utils/fs";
import { tempFolder } from "@halinka/utils/testing";
import { parseRepoConfig } from "@halinka/workflow";
import { describe, expect, it } from "vitest";

import { listDevcontainers, setUpRepo } from "./repoSetup";
import { createRepo, writeDefinition } from "./testing";

const readConfig = async (repoPath: string) =>
  parseRepoConfig(await readFile(join(repoPath, ".halinka/config.yml"), "utf8"));

describe("repoSetup", () => {
  it("lists the devcontainers in the order of the spec", async () => {
    const repoPath = await createRepo({ commit: false });
    await writeDefinition(repoPath, ".devcontainer/web/devcontainer.json", "{}");
    await writeDefinition(repoPath, ".devcontainer.json", "{}");
    await writeDefinition(repoPath, ".devcontainer/devcontainer.json", "{}");

    expect(await listDevcontainers({ repoPath })).toEqual([
      ".devcontainer/devcontainer.json",
      ".devcontainer.json",
      ".devcontainer/web/devcontainer.json",
    ]);
  });

  it("lists the devcontainers when .halinka/ points outside the repo", async () => {
    const repoPath = await createRepo({ commit: false });
    await writeDefinition(repoPath, ".devcontainer.json", "{}");
    await symlink(await tempFolder(), join(repoPath, ".halinka"));

    expect(await listDevcontainers({ repoPath })).toEqual([".devcontainer.json"]);
  });

  it("refuses to list the devcontainers of a folder that is not the root of a git repo", async () => {
    const repoPath = join(await createRepo({ commit: false }), "src");
    await mkdir(repoPath);

    await expect(listDevcontainers({ repoPath })).rejects.toMatchObject({
      code: "invalid_input",
      message: `${repoPath} is not the root of a git repo`,
    });
  });

  it("writes the config, a new devcontainer and the smoke workflow", async () => {
    const repoPath = await createRepo({ commit: false });
    const devcontainer = ".devcontainer/devcontainer.json";

    expect(await setUpRepo({ repoPath, server: "local", devcontainer })).toEqual({
      files: [".halinka/config.yml", devcontainer, ".halinka/workflows/smoke.yml"],
    });
    expect(await readConfig(repoPath)).toMatchObject({ value: { server: "local", devcontainer } });
  });

  it("keeps a devcontainer that the repo has", async () => {
    const repoPath = await createRepo({ commit: false });
    await writeDefinition(repoPath, ".devcontainer.json", '{ "image": "node" }');

    await setUpRepo({
      repoPath,
      server: "https://halinka.example",
      devcontainer: ".devcontainer.json",
    });

    expect(await readFile(join(repoPath, ".devcontainer.json"), "utf8")).toBe(
      '{ "image": "node" }',
    );
  });

  it("writes no devcontainer for none", async () => {
    const repoPath = await createRepo({ commit: false });

    await setUpRepo({ repoPath, server: "local" });

    expect(await readConfig(repoPath)).toMatchObject({ value: { server: "local" } });
    expect(await pathExists(join(repoPath, ".devcontainer"))).toBe(false);
  });

  it("removes the files that it wrote when a write fails", async () => {
    const repoPath = await createRepo({ commit: false });
    await writeFile(join(repoPath, ".devcontainer"), "");

    await expect(
      setUpRepo({ repoPath, server: "local", devcontainer: ".devcontainer/devcontainer.json" }),
    ).rejects.toMatchObject({ code: "invalid_definitions" });
    expect(await pathExists(join(repoPath, ".halinka"))).toBe(false);
  });

  it("keeps the files of one of two setups that run at the same time", async () => {
    const repoPath = await createRepo({ commit: false });
    const setUp = () => setUpRepo({ repoPath, server: "local" });

    const results = await Promise.allSettled([setUp(), setUp()]);

    expect(results.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await readConfig(repoPath)).toMatchObject({ value: { server: "local" } });
    expect(await pathExists(join(repoPath, ".halinka/workflows/smoke.yml"))).toBe(true);
  });

  it("refuses to create a devcontainer through a link that points outside the repo", async () => {
    const repoPath = await createRepo({ commit: false });
    const outside = await tempFolder();
    await symlink(outside, join(repoPath, ".devcontainer"));

    await expect(
      setUpRepo({ repoPath, server: "local", devcontainer: ".devcontainer/devcontainer.json" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await pathExists(join(outside, "devcontainer.json"))).toBe(false);
  });

  it("refuses to set up a repo that has .halinka/", async () => {
    const repoPath = await createRepo({ commit: false });
    await mkdir(join(repoPath, ".halinka"));

    await expect(setUpRepo({ repoPath, server: "local" })).rejects.toMatchObject({
      code: "invalid_input",
      message: `${repoPath} has .halinka/. Edit its files to change the settings`,
    });
  });

  it("refuses a devcontainer that the repo does not have", async () => {
    const repoPath = await createRepo({ commit: false });

    await expect(
      setUpRepo({ repoPath, server: "local", devcontainer: ".devcontainer/web/devcontainer.json" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await pathExists(join(repoPath, ".halinka"))).toBe(false);
  });

  it("refuses a server that is not local or a server URL", async () => {
    const repoPath = await createRepo({ commit: false });

    await expect(
      setUpRepo({ repoPath, server: "http://user:secret@halinka.example" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
