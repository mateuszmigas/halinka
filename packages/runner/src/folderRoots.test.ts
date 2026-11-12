import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";

import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it } from "vitest";

import { FolderRoots } from "./folderRoots";
import { createRepo } from "./testing";

const runnerHome = "/nonexistent/halinka-runner-home";

describe("FolderRoots", () => {
  it("accepts a root", async () => {
    const root = await tempFolder();

    await expect(new FolderRoots([root], runnerHome).requireInRoots(root)).resolves.toBeUndefined();
  });

  it("accepts a folder in a root, also one that does not exist yet", async () => {
    const root = await tempFolder();

    await expect(
      new FolderRoots([root], runnerHome).requireInRoots(join(root, "a/b")),
    ).resolves.toBeUndefined();
  });

  it("refuses a folder outside the roots", async () => {
    const roots = new FolderRoots([await tempFolder()], runnerHome);

    await expect(roots.requireInRoots(await tempFolder())).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("refuses a path that goes out with ..", async () => {
    const root = await tempFolder();

    await expect(
      new FolderRoots([root], runnerHome).requireInRoots(join(root, "..", "other")),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("refuses a path that goes out with .. after a missing folder", async () => {
    const root = await tempFolder();
    const path = `${root}/missing${"/..".repeat(20)}/etc`;

    await expect(new FolderRoots([root], runnerHome).requireInRoots(path)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("refuses a relative path", async () => {
    await expect(
      new FolderRoots([await tempFolder()], runnerHome).requireInRoots("etc"),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("refuses a folder in a root whose git repo is outside the roots", async () => {
    const repo = await createRepo();
    const root = join(repo, "sub");
    await mkdir(root);

    await expect(
      new FolderRoots([root], runnerHome).requireRepoInRoots(root),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("accepts a repo in a root", async () => {
    const repo = await createRepo();

    await expect(
      new FolderRoots([repo], runnerHome).requireRepoInRoots(repo),
    ).resolves.toBeUndefined();
  });

  it("refuses a symlink in a root that leads outside", async () => {
    const root = await tempFolder();
    const link = join(root, "link");
    await symlink(await tempFolder(), link);

    await expect(new FolderRoots([root], runnerHome).requireInRoots(link)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("refuses a folder with the name of a root as a prefix", async () => {
    const root = await tempFolder();
    await mkdir(`${root}-other`, { recursive: true });

    await expect(
      new FolderRoots([root], runnerHome).requireInRoots(`${root}-other`),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("accepts a root through a symlink to it", async () => {
    const root = await tempFolder();
    const link = join(await tempFolder(), "link");
    await symlink(root, link);

    await expect(new FolderRoots([link], runnerHome).requireInRoots(root)).resolves.toBeUndefined();
  });
  it("refuses a folder in the folder of the runner", async () => {
    const root = await tempFolder();
    const home = join(root, ".halinka");
    await mkdir(home);

    await expect(
      new FolderRoots([root], home).requireInRoots(join(home, "logins")),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: `The server cannot reach ${join(home, "logins")}: it holds the folder of this runner, ${home}.`,
    });
  });

  it.each([
    ["the repo", ""],
    ["a folder of the repo", "src"],
  ])("refuses %s of a repo that holds the folder of the runner", async (_, folder) => {
    const repoPath = await createRepo();
    const home = join(repoPath, ".halinka");
    await mkdir(home);
    await mkdir(join(repoPath, "src"));

    await expect(
      new FolderRoots([repoPath], home).requireRepoInRoots(join(repoPath, folder)),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: `The server cannot reach ${repoPath}: it holds the folder of this runner, ${home}.`,
    });
  });

  it("accepts a root that holds the folder of the runner", async () => {
    const root = await tempFolder();
    const home = join(root, ".halinka");
    await mkdir(home);

    await expect(new FolderRoots([root], home).requireInRoots(root)).resolves.toBeUndefined();
  });
});
