import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { pathExists } from "@halinka/utils/fs";
import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it, vi } from "vitest";

import { Containers } from "./containers";
import { commitAll, createRepo, writeDefinition } from "./testing";
import { Workspaces } from "./workspaces";

const setUp = async () => {
  const repoPath = await createRepo();
  await writeDefinition(repoPath, ".devcontainer/devcontainer.json", "{}");
  const baseSha = await commitAll(repoPath, "devcontainer");
  const workspacesFolder = await tempFolder();
  const containers = await Containers.create(workspacesFolder, new Workspaces(workspacesFolder));
  const run = { workflowRunId: 1, repoPath, isMirror: false, definitionSha: baseSha };
  return { containers, run };
};

describe("Containers", () => {
  it("gives runs with one id in two homes two names", async () => {
    const first = await Containers.create(await tempFolder(), new Workspaces(await tempFolder()));
    const second = await Containers.create(await tempFolder(), new Workspaces(await tempFolder()));

    expect(first.nameOf(1)).not.toBe(second.nameOf(1));
  });

  it("gives a home and a symlink to it one name", async () => {
    const folder = await tempFolder();
    const link = join(await tempFolder(), "link");
    await symlink(folder, link);
    const nameIn = async (folder: string) =>
      (await Containers.create(folder, new Workspaces(folder))).nameOf(1);

    expect(await nameIn(link)).toBe(await nameIn(folder));
  });

  it("gives a run one name for each start in its home", async () => {
    const folder = await tempFolder();
    const nameOf = async () => (await Containers.create(folder, new Workspaces(folder))).nameOf(1);

    expect(await nameOf()).toBe(await nameOf());
  });

  it("builds from the definition commit, not from later commits", async () => {
    const { containers, run } = await setUp();
    await writeDefinition(run.repoPath, ".devcontainer/devcontainer.json", '{"from":"later"}');
    await commitAll(run.repoPath, "a change in a pull request");

    const { treeFolder, configPath } = await containers.prepareTree({
      ...run,
      devcontainer: ".devcontainer/devcontainer.json",
    });

    expect(await readFile(join(treeFolder, configPath), "utf8")).toBe("{}");
  });

  it("runs no filter of the host config in the tree of a mirror", async () => {
    const { containers, run } = await setUp();
    await writeDefinition(run.repoPath, ".gitattributes", "* filter=host\n");
    const definitionSha = await commitAll(run.repoPath, "Filter");
    const root = await tempFolder();
    const marker = join(root, "filter-ran");
    await writeFile(join(root, "global"), `[filter "host"]\n\tsmudge = touch ${marker} && cat\n`);
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(root, "global"));
    const devcontainer = ".devcontainer/devcontainer.json";

    await containers.prepareTree({ ...run, isMirror: true, definitionSha, devcontainer });

    expect(await pathExists(marker)).toBe(false);
  });

  it("refuses a devcontainer path outside the repo", async () => {
    const { containers, run } = await setUp();

    await expect(
      containers.prepareTree({ ...run, devcontainer: "../../secret.json" }),
    ).rejects.toThrow("../../secret.json is outside the repo");
  });

  it("refuses a run whose repo config names no devcontainer", async () => {
    const { containers, run } = await setUp();

    await expect(containers.prepareTree(run)).rejects.toThrow(
      "The repo has no devcontainer in .halinka/config.yml",
    );
  });

  it("refuses a base commit without the devcontainer", async () => {
    const { containers, run } = await setUp();

    await expect(
      containers.prepareTree({ ...run, devcontainer: ".devcontainer/other.json" }),
    ).rejects.toThrow("has no .devcontainer/other.json. Commit it, then start a new run.");
  });
});
