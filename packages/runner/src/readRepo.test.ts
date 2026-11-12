import { chmod, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { hostGit } from "@halinka/sandbox/host";
import { hashOf } from "@halinka/utils/hash";
import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it, onTestFinished } from "vitest";

import { readRepo } from "./readRepo";
import { createRepo, writeDefinition as writeRepoDefinition } from "./testing";

const setUp = async () => {
  const repoPath = await createRepo();
  const writeDefinition = (path: string, content: string | Buffer) =>
    writeRepoDefinition(repoPath, path, content);
  const readFiles = async () => {
    const { files } = await readRepo({ repoPath });
    return Object.fromEntries(Object.entries(files).map(([path, { source }]) => [path, source]));
  };
  await writeDefinition(".halinka/workflows/build.yml", "schema_version: 1\nname: Build\n");
  return { repoPath, writeDefinition, readFiles };
};

describe("readRepo", () => {
  it("reads every file under .halinka/, also in subfolders", async () => {
    const { writeDefinition, readFiles } = await setUp();
    await writeDefinition(".halinka/config.yml", "schema_version: 1\nserver: local\n");

    expect(await readFiles()).toEqual({
      ".halinka/config.yml": "schema_version: 1\nserver: local\n",
      ".halinka/workflows/build.yml": "schema_version: 1\nname: Build\n",
    });
  });

  it("hashes the bytes of a file, not its decoded text", async () => {
    const { repoPath, writeDefinition } = await setUp();
    const bytes = Buffer.from([0xff, 0x0a]);
    await writeDefinition(".halinka/config.yml", bytes);

    const { files } = await readRepo({ repoPath });

    expect(files[".halinka/config.yml"]).toEqual({ source: "\uFFFD\n", hash: hashOf(bytes) });
  });

  it("gives the real path of a repo that a symlink leads to", async () => {
    const { repoPath } = await setUp();
    const link = join(await tempFolder(), "link");
    await symlink(repoPath, link);

    expect(await readRepo({ repoPath: link })).toMatchObject({ realPath: repoPath });
  });

  it("refuses a .halinka/ that is the repo root", async () => {
    const { repoPath } = await setUp();
    await rm(join(repoPath, ".halinka"), { recursive: true });
    await symlink(".", join(repoPath, ".halinka"));

    await expect(readRepo({ repoPath })).rejects.toMatchObject({
      code: "invalid_definitions",
      message: `.halinka/ in ${repoPath} points outside the repo`,
    });
  });

  it("refuses a .halinka that is a file", async () => {
    const { repoPath } = await setUp();
    await rm(join(repoPath, ".halinka"), { recursive: true });
    await writeFile(join(repoPath, ".halinka"), "x");

    await expect(readRepo({ repoPath })).rejects.toMatchObject({
      code: "invalid_definitions",
      message: `.halinka in ${repoPath} is not a folder`,
    });
  });

  it("gives the commit of HEAD", async () => {
    const { repoPath } = await setUp();
    const head = await hostGit(repoPath).run("rev-parse", "HEAD");

    expect((await readRepo({ repoPath })).head).toBe(head);
  });

  it.each<[string, (repoPath: string) => Promise<string>, (path: string) => string]>([
    ["a relative path", async () => "code/app", (path) => `"${path}" is not an absolute path`],
    [
      "a missing folder",
      async (repoPath) => join(repoPath, "missing"),
      (path) => `${path} is not a folder`,
    ],
    [
      "a file",
      async (repoPath) => join(repoPath, ".halinka/workflows/build.yml"),
      (path) => `${path} is not a folder`,
    ],
    ["a folder that is not a git repo", tempFolder, (path) => `${path} is not a git repo`],
    [
      "a repo without a commit",
      () => createRepo({ commit: false }),
      (path) => `${path} has no commit`,
    ],
  ])("refuses %s", async (_, createPath, message) => {
    const { repoPath } = await setUp();
    const path = await createPath(repoPath);

    await expect(readRepo({ repoPath: path })).rejects.toMatchObject({
      code: "invalid_input",
      message: message(path),
    });
  });

  it("reads a symlink to a file in .halinka/ at the path of the link", async () => {
    const { repoPath, readFiles } = await setUp();
    await symlink(
      join(repoPath, ".halinka/workflows/build.yml"),
      join(repoPath, ".halinka/build.yml"),
    );

    expect(await readFiles()).toEqual({
      ".halinka/build.yml": "schema_version: 1\nname: Build\n",
      ".halinka/workflows/build.yml": "schema_version: 1\nname: Build\n",
    });
  });

  it("skips a symlink to a file outside .halinka/", async () => {
    const { repoPath, readFiles } = await setUp();
    await writeFile(join(repoPath, "secret.txt"), "secret");
    await symlink(join(repoPath, "secret.txt"), join(repoPath, ".halinka/secret.yml"));

    expect(await readFiles()).toEqual({
      ".halinka/workflows/build.yml": "schema_version: 1\nname: Build\n",
    });
  });

  it("skips a symlink to a folder", async () => {
    const { repoPath, readFiles } = await setUp();
    await symlink(join(repoPath, ".halinka"), join(repoPath, ".halinka/workflows/loop"));

    expect(await readFiles()).toEqual({
      ".halinka/workflows/build.yml": "schema_version: 1\nname: Build\n",
    });
  });

  it("skips a symlink through a file", async () => {
    const { repoPath, readFiles } = await setUp();
    await symlink(join(repoPath, "README.md/x.yml"), join(repoPath, ".halinka/x.yml"));

    expect(await readFiles()).toEqual({
      ".halinka/workflows/build.yml": "schema_version: 1\nname: Build\n",
    });
  });

  it("skips a symlink to itself", async () => {
    const { repoPath, readFiles } = await setUp();
    await symlink(join(repoPath, ".halinka/self"), join(repoPath, ".halinka/self"));

    expect(await readFiles()).toEqual({
      ".halinka/workflows/build.yml": "schema_version: 1\nname: Build\n",
    });
  });

  it.skipIf(process.getuid?.() === 0)("refuses a folder that it cannot read", async () => {
    const { repoPath } = await setUp();
    const folder = join(repoPath, ".halinka/workflows");
    await chmod(folder, 0o000);
    onTestFinished(() => chmod(folder, 0o755));

    await expect(readRepo({ repoPath })).rejects.toMatchObject({
      code: "invalid_definitions",
      message: ".halinka/workflows cannot be read",
    });
  });

  it("refuses a .halinka/ that points outside the repo", async () => {
    const { repoPath } = await setUp();
    await rm(join(repoPath, ".halinka"), { recursive: true });
    await symlink(await tempFolder(), join(repoPath, ".halinka"));

    await expect(readRepo({ repoPath })).rejects.toMatchObject({
      code: "invalid_definitions",
      message: `.halinka/ in ${repoPath} points outside the repo`,
    });
  });

  it("gives no files when the repo has no .halinka/", async () => {
    const { repoPath, readFiles } = await setUp();
    await rm(join(repoPath, ".halinka"), { recursive: true });

    expect(await readFiles()).toEqual({});
  });

  it("refuses a file larger than 1 MiB", async () => {
    const { repoPath, writeDefinition } = await setUp();
    await writeDefinition(".halinka/big.yml", "x".repeat(1024 * 1024 + 1));

    await expect(readRepo({ repoPath })).rejects.toMatchObject({
      code: "invalid_definitions",
      message: ".halinka/big.yml is larger than 1 MiB",
    });
  });

  it("reads 200 files", async () => {
    const { writeDefinition, readFiles } = await setUp();
    await Promise.all(
      Array.from({ length: 199 }, (_, index) => writeDefinition(`.halinka/f${index}.yml`, "")),
    );

    expect(Object.keys(await readFiles())).toHaveLength(200);
  });

  it("refuses more than 200 files", async () => {
    const { repoPath, writeDefinition } = await setUp();
    await Promise.all(
      Array.from({ length: 200 }, (_, index) => writeDefinition(`.halinka/f${index}.yml`, "")),
    );

    await expect(readRepo({ repoPath })).rejects.toMatchObject({
      code: "invalid_definitions",
      message: ".halinka/ has more than 200 files",
    });
  });

  it("refuses files larger than 4 MiB in total", async () => {
    const { repoPath, writeDefinition } = await setUp();
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        writeDefinition(`.halinka/f${index}.yml`, "x".repeat(900 * 1024)),
      ),
    );

    await expect(readRepo({ repoPath })).rejects.toMatchObject({
      code: "invalid_definitions",
      message: ".halinka/ is larger than 4 MiB",
    });
  });
});
