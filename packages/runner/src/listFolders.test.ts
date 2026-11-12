import { mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it } from "vitest";

import { listFolders, maxFolders } from "./listFolders";

const namesIn = async (folder: string) =>
  (await listFolders({ path: folder })).folders.map(({ name }) => name);

describe("listFolders", () => {
  it("sorts the subfolders by name", async () => {
    const folder = await tempFolder();
    for (const name of ["web", "api", "docs"]) await mkdir(join(folder, name));

    expect(await namesIn(folder)).toEqual(["api", "docs", "web"]);
  });

  it("leaves out hidden folders, files and symlinks", async () => {
    const folder = await tempFolder();
    await mkdir(join(folder, "app"));
    await mkdir(join(folder, ".cache"));
    await writeFile(join(folder, "notes.txt"), "");
    await symlink(join(folder, "app"), join(folder, "link"));

    expect(await namesIn(folder)).toEqual(["app"]);
  });

  it("marks a subfolder with a .git folder or a .git file as a repo", async () => {
    const folder = await tempFolder();
    await mkdir(join(folder, "clone", ".git"), { recursive: true });
    await mkdir(join(folder, "plain"));
    await mkdir(join(folder, "worktree"));
    await writeFile(join(folder, "worktree", ".git"), "gitdir: /elsewhere\n");

    expect((await listFolders({ path: folder })).folders).toEqual([
      { name: "clone", path: join(folder, "clone"), isRepo: true },
      { name: "plain", path: join(folder, "plain"), isRepo: false },
      { name: "worktree", path: join(folder, "worktree"), isRepo: true },
    ]);
  });

  it("marks the listed folder as a repo", async () => {
    const folder = await tempFolder();
    await mkdir(join(folder, ".git"));

    expect(await listFolders({ path: folder })).toMatchObject({ path: folder, isRepo: true });
  });

  it("gives the parent of the listed folder", async () => {
    const folder = await tempFolder();

    expect((await listFolders({ path: folder })).parent).toBe(dirname(folder));
  });

  it("lists the home folder of the runner user for no path", async () => {
    expect((await listFolders({})).path).toBe(homedir());
  });

  it("gives no parent for the root", async () => {
    expect((await listFolders({ path: "/" })).parent).toBeUndefined();
  });

  it(`lists at most ${maxFolders} subfolders`, async () => {
    const folder = await tempFolder();
    const names = Array.from({ length: maxFolders + 1 }, (_, index) => `f${index}`);
    await Promise.all(names.map((name) => mkdir(join(folder, name))));

    const listing = await listFolders({ path: folder });

    expect(listing.folders).toHaveLength(maxFolders);
    expect(listing.isTruncated).toBe(true);
  });

  it("refuses a relative path", async () => {
    await expect(listFolders({ path: "code" })).rejects.toMatchObject({
      code: "invalid_input",
      message: '"code" is not an absolute path',
    });
  });

  it("refuses a folder that it cannot open", async () => {
    const missing = join(await tempFolder(), "missing");

    await expect(listFolders({ path: missing })).rejects.toMatchObject({
      code: "invalid_input",
      message: `Halinka cannot open ${missing}`,
    });
  });
});
