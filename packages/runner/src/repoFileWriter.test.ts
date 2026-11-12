import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { pathExists } from "@halinka/utils/fs";
import { hashOf } from "@halinka/utils/hash";
import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it, onTestFinished } from "vitest";

import { RepoFileWriter } from "./repoFileWriter";
import { createRepo, writeDefinition as writeRepoDefinition } from "./testing";

const path = ".halinka/workflows/build.yml";

const setUp = async () => {
  const repoPath = await createRepo();
  const writer = new RepoFileWriter();
  const writeDefinition = (file: string, text: string) => writeRepoDefinition(repoPath, file, text);
  const write = (source: string, expectedHash: string | undefined, file = path) =>
    writer.write({ repoPath, path: file, source, expectedHash });
  const readContent = (file: string) => readFile(join(repoPath, file), "utf8");
  return { repoPath, writer, writeDefinition, write, readContent };
};

describe("RepoFileWriter", () => {
  it("creates a file and its folders when no file is expected", async () => {
    const { write, readContent } = await setUp();
    await write("name: Build\n", undefined);

    expect(await readContent(path)).toBe("name: Build\n");
  });

  it("gives the SHA-256 of the written bytes", async () => {
    const { write } = await setUp();
    expect(await write("name: Build\n", undefined)).toEqual({ hash: hashOf("name: Build\n") });
  });

  it("replaces a file that still has the expected hash", async () => {
    const { writeDefinition, write, readContent } = await setUp();
    await writeDefinition(path, "name: Build\n");

    await write("name: Built\n", hashOf("name: Build\n"));

    expect(await readContent(path)).toBe("name: Built\n");
  });

  it("accepts a write of the content that the file already has", async () => {
    const { writeDefinition, write } = await setUp();
    await writeDefinition(path, "name: Build\n");

    expect(await write("name: Build\n", undefined)).toEqual({ hash: hashOf("name: Build\n") });
    expect(await write("name: Build\n", "stale")).toEqual({ hash: hashOf("name: Build\n") });
  });

  it("lets only one of two writes with the same expected hash pass", async () => {
    const { writeDefinition, write, readContent } = await setUp();
    await writeDefinition(path, "name: Build\n");
    const hash = hashOf("name: Build\n");

    const results = await Promise.allSettled([write("name: A\n", hash), write("name: B\n", hash)]);

    expect(results.map(({ status }) => status)).toEqual(["fulfilled", "rejected"]);
    expect(await readContent(path)).toBe("name: A\n");
  });

  it("refuses to replace a file that changed", async () => {
    const { writeDefinition, write, readContent } = await setUp();
    await writeDefinition(path, "name: Changed\n");

    await expect(write("name: Built\n", hashOf("name: Build\n"))).rejects.toMatchObject({
      code: "conflict",
      message: `${path} changed since it was read`,
    });
    expect(await readContent(path)).toBe("name: Changed\n");
  });

  it("refuses to create a file that exists", async () => {
    const { writeDefinition, write, readContent } = await setUp();
    await writeDefinition(path, "name: Build\n");

    await expect(write("name: Built\n", undefined)).rejects.toMatchObject({
      code: "conflict",
      message: `${path} already exists`,
    });
    expect(await readContent(path)).toBe("name: Build\n");
  });

  it("refuses to replace a file that does not exist", async () => {
    const { repoPath, write } = await setUp();
    await expect(write("name: Built\n", hashOf("name: Build\n"))).rejects.toMatchObject({
      code: "conflict",
      message: `${path} does not exist`,
    });
    expect(await pathExists(join(repoPath, path))).toBe(false);
  });

  it.each([
    "build.yml",
    ".halinka",
    ".halinka/",
    ".halinka/../build.yml",
    ".halinka/workflows/./build.yml",
    ".halinka/workflows/build\0.yml",
    "/etc/passwd",
  ])("refuses the path %s", async (file) => {
    const { write } = await setUp();
    await expect(write("x", undefined, file)).rejects.toMatchObject({
      code: "invalid_input",
      message: `${file} is not a file in .halinka/`,
    });
  });

  it("refuses a file whose bytes are larger than 1 MiB", async () => {
    const { write } = await setUp();
    await expect(write("é".repeat(512 * 1024 + 1), undefined)).rejects.toMatchObject({
      code: "invalid_input",
      message: `${path} is larger than 1 MiB`,
    });
  });

  it("refuses a folder that points outside .halinka/", async () => {
    const { repoPath, write } = await setUp();
    await mkdir(join(repoPath, ".halinka"));
    await symlink(await tempFolder(), join(repoPath, ".halinka/workflows"));

    await expect(write("x", undefined)).rejects.toMatchObject({
      code: "invalid_input",
      message: `${path} points outside .halinka/`,
    });
  });

  it("refuses a file that points outside .halinka/", async () => {
    const { repoPath, write, readContent } = await setUp();
    await writeFile(join(repoPath, "secret.txt"), "secret");
    await mkdir(join(repoPath, ".halinka/workflows"), { recursive: true });
    await symlink(join(repoPath, "secret.txt"), join(repoPath, path));

    await expect(write("x", hashOf("secret"))).rejects.toMatchObject({
      code: "invalid_input",
      message: `${path} points outside .halinka/`,
    });
    expect(await readContent("secret.txt")).toBe("secret");
  });

  it("refuses a path through a file", async () => {
    const { writeDefinition, write } = await setUp();
    await writeDefinition(".halinka/workflows", "x");

    await expect(write("x", undefined)).rejects.toMatchObject({
      code: "invalid_input",
      message: ".halinka/workflows is not a folder",
    });
  });

  it("refuses a path that is not a regular file", async () => {
    const { repoPath, write } = await setUp();
    await mkdir(join(repoPath, path), { recursive: true });

    await expect(write("x", undefined)).rejects.toMatchObject({
      code: "invalid_input",
      message: `${path} is not a file`,
    });
  });

  it.skipIf(process.getuid?.() === 0)("refuses a folder that it cannot write", async () => {
    const { repoPath, write } = await setUp();
    const folder = join(repoPath, ".halinka/workflows");
    await mkdir(folder, { recursive: true });
    await chmod(folder, 0o500);
    onTestFinished(() => chmod(folder, 0o755));

    await expect(write("x", undefined)).rejects.toMatchObject({
      code: "invalid_definitions",
      message: `${path} cannot be written`,
    });
  });

  it("refuses a .halinka that is a file", async () => {
    const { repoPath, write } = await setUp();
    await writeFile(join(repoPath, ".halinka"), "x");

    await expect(write("x", undefined)).rejects.toMatchObject({
      code: "invalid_definitions",
      message: `.halinka in ${repoPath} is not a folder`,
    });
  });

  it("refuses a folder that is not a git repo", async () => {
    const { writer } = await setUp();
    const folder = await tempFolder();

    await expect(writer.write({ repoPath: folder, path, source: "x" })).rejects.toMatchObject({
      code: "invalid_input",
      message: `${folder} is not a git repo`,
    });
  });

  it("refuses a .halinka/ that points outside the repo", async () => {
    const { repoPath, write } = await setUp();
    await symlink(await tempFolder(), join(repoPath, ".halinka"));

    await expect(write("x", undefined)).rejects.toMatchObject({
      code: "invalid_definitions",
      message: `.halinka/ in ${repoPath} points outside the repo`,
    });
  });
});
