import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createFileOnce,
  findFileSize,
  findNearestRealPath,
  findRealPath,
  isInsideFolder,
  isRealPathInside,
  readBinaryFile,
  readTextFile,
  replaceFile,
} from "./fs";
import { tempFolder } from "./testing";

describe("fs", () => {
  it("finds no real path for a missing path", async () => {
    const root = await tempFolder();

    expect(await findRealPath(join(root, "missing"))).toBeUndefined();
  });

  it("finds no real path for a symlink loop", async () => {
    const root = await tempFolder();
    await symlink(join(root, "loop"), join(root, "loop"));

    expect(await findRealPath(join(root, "loop"))).toBeUndefined();
  });

  it("finds no real path for a path through a file", async () => {
    const root = await tempFolder();
    await writeFile(join(root, "a.txt"), "abc");

    expect(await findRealPath(join(root, "a.txt", "b"))).toBeUndefined();
  });

  it.each<[string, string, boolean]>([
    ["/code/app", "/code/app", true],
    ["/code/app/src/a.ts", "/code/app", true],
    ["/code/app-other/a.ts", "/code/app", false],
    ["/code", "/code/app", false],
  ])("tells whether %s is inside %s", (path, folder, inside) => {
    expect(isInsideFolder(path, folder)).toBe(inside);
  });

  it("finds the size of a file", async () => {
    const root = await tempFolder();
    await writeFile(join(root, "a.txt"), "abc");

    expect(await findFileSize(join(root, "a.txt"))).toBe(3);
  });

  it("finds no size for a folder", async () => {
    const root = await tempFolder();
    await mkdir(join(root, "folder"));

    expect(await findFileSize(join(root, "folder"))).toBeUndefined();
  });

  it("finds no size for a missing path", async () => {
    const root = await tempFolder();

    expect(await findFileSize(join(root, "missing"))).toBeUndefined();
  });

  it("reads no text from a missing file", async () => {
    const root = await tempFolder();

    expect(await readTextFile(join(root, "missing.txt"))).toBeUndefined();
  });

  it("rejects when it reads text from a folder", async () => {
    const root = await tempFolder();

    await expect(readTextFile(root)).rejects.toThrow("EISDIR");
  });

  it("reads no bytes from a missing file", async () => {
    const root = await tempFolder();

    expect(await readBinaryFile(join(root, "missing.bin"))).toBeUndefined();
  });

  it("reads the bytes of a file", async () => {
    const root = await tempFolder();
    await writeFile(join(root, "a.bin"), Buffer.from([0xff, 0x00]));

    expect(await readBinaryFile(join(root, "a.bin"))).toEqual(Buffer.from([0xff, 0x00]));
  });

  it("finds the real path of the nearest existing ancestor", async () => {
    const root = await tempFolder();
    await mkdir(join(root, "dir"));
    await symlink(join(root, "dir"), join(root, "link"));

    expect(await findNearestRealPath(join(root, "link", "missing", "deeper"))).toBe(
      join(root, "dir"),
    );
  });

  it("finds a path through a symlink out of a folder outside it", async () => {
    const root = await tempFolder();
    await mkdir(join(root, "dir"));
    await symlink(tmpdir(), join(root, "dir", "link"));

    expect(await isRealPathInside(join(root, "dir", "link", "missing"), join(root, "dir"))).toBe(
      false,
    );
  });

  it("creates a file once with its content", async () => {
    const root = await tempFolder();
    const path = join(root, "lock");

    const created = [await createFileOnce(path, "first"), await createFileOnce(path, "second")];

    expect(created).toEqual([true, false]);
    expect(await readFile(path, "utf8")).toBe("first");
  });

  it("replaces the content of a file", async () => {
    const root = await tempFolder();
    const path = join(root, "login.json");
    await writeFile(path, "first");

    await replaceFile(path, "second");

    expect(await readFile(path, "utf8")).toBe("second");
  });

  it("removes its temporary file when the replace fails", async () => {
    const root = await tempFolder();
    const path = join(root, "folder");
    await mkdir(join(path, "inside"), { recursive: true });

    await expect(replaceFile(path, "content")).rejects.toThrow();

    expect(await readdir(root)).toEqual(["folder"]);
  });
});
