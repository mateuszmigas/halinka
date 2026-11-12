import { chmod, stat, symlink } from "node:fs/promises";
import { join } from "node:path";

import { readTextFile } from "@halinka/utils/fs";
import { tempFolder, writeFiles } from "@halinka/utils/testing";
import { describe, expect, it, onTestFinished } from "vitest";

import { migrateRepo } from "./migrate";

const configPath = ".halinka/config.yml";

const buildPath = ".halinka/workflows/build.yml";

const legacyWorkflow =
  "name: Build\nenvironment: default\nsteps:\n  - id: build\n    type: shell\n    run: make\n";

const legacyConfig = "server: local\nenvironments:\n  default:\n    devcontainer: dc.json\n";

const setUp = async (files: Record<string, string> = {}) => {
  const root = await tempFolder();
  await writeFiles(root, { [configPath]: legacyConfig, [buildPath]: legacyWorkflow, ...files });
  return root;
};

describe("migrateRepo", () => {
  it("gives the changes of each file with its line", async () => {
    const root = await setUp();

    const { changes } = await migrateRepo(root, { isWritten: false });

    expect(changes).toContain(
      ".halinka/workflows/build.yml:2 Deleted environment. config.yml names the devcontainer.",
    );
  });

  it("writes nothing without isWritten", async () => {
    const root = await setUp();

    await migrateRepo(root, { isWritten: false });

    expect(await readTextFile(join(root, buildPath))).toBe(legacyWorkflow);
  });

  it("writes the changed files with isWritten", async () => {
    const root = await setUp();

    await migrateRepo(root, { isWritten: true });

    expect(await readTextFile(join(root, configPath))).toBe(
      "schema_version: 1\nserver: local\ndevcontainer: dc.json\n",
    );
  });

  it("counts the files that change", async () => {
    const root = await setUp({
      ".halinka/workflows/test.yml":
        "schema_version: 1\nname: Test\nsteps: [{ id: a, type: shell, run: ls }]\n",
    });

    expect(await migrateRepo(root, { isWritten: false })).toMatchObject({ files: 2 });
  });

  it("changes nothing in a repo that it migrated", async () => {
    const root = await setUp();
    await migrateRepo(root, { isWritten: true });

    expect(await migrateRepo(root, { isWritten: true })).toEqual({
      files: 0,
      changes: [],
      notes: [],
      failedWrites: [],
      problems: [],
    });
  });

  it("migrates the workflows of a repo without config.yml", async () => {
    const root = await tempFolder();
    await writeFiles(root, { [buildPath]: legacyWorkflow });

    expect(await migrateRepo(root, { isWritten: false })).toMatchObject({ files: 1 });
  });

  it("gives the problems that stay in a workflow, with the agents of the presets", async () => {
    const root = await setUp({
      ".halinka/workflows/review.yml":
        "name: Review\nsteps:\n  - id: review\n    type: agent\n    agent: gemini\n    prompt: Review\n",
    });

    const { problems } = await migrateRepo(root, { isWritten: false });

    expect(problems).toEqual([
      expect.stringMatching(/^\.halinka\/workflows\/review\.yml:6:5 There is no agent "gemini"/),
    ]);
  });

  it("gives the problems that stay in config.yml", async () => {
    const root = await setUp({
      [configPath]: "environments:\n  default:\n    devcontainer: dc.json\n",
    });

    const { problems } = await migrateRepo(root, { isWritten: false });

    expect(problems).toEqual([
      ".halinka/config.yml:1:1 Add server: local, or the URL of your Halinka server",
    ]);
  });

  it("keeps the mode of a file that it writes", async () => {
    const root = await setUp();
    await chmod(join(root, buildPath), 0o600);

    await migrateRepo(root, { isWritten: true });

    expect((await stat(join(root, buildPath))).mode & 0o777).toBe(0o600);
  });

  it("gives a symbolic link as a problem and does not change it", async () => {
    const root = await setUp();
    await symlink("build.yml", join(root, ".halinka/workflows/link.yml"));

    const { problems } = await migrateRepo(root, { isWritten: true });

    expect(problems).toEqual([
      ".halinka/workflows/link.yml is a symbolic link. migrate does not change it.",
    ]);
  });

  it("gives the files that it could not write, and writes the others", async () => {
    const root = await setUp();
    const workflows = join(root, ".halinka/workflows");
    await chmod(workflows, 0o555);
    onTestFinished(() => chmod(workflows, 0o755));

    const { failedWrites } = await migrateRepo(root, { isWritten: true });

    expect({
      failedWrites: failedWrites.map((line) => line.split(" ")[0]),
      config: await readTextFile(join(root, configPath)),
    }).toEqual({
      failedWrites: [buildPath],
      config: "schema_version: 1\nserver: local\ndevcontainer: dc.json\n",
    });
  });

  it("fails when it cannot read the workflows folder", async () => {
    const root = await setUp();
    const workflows = join(root, ".halinka/workflows");
    await chmod(workflows, 0o000);
    onTestFinished(() => chmod(workflows, 0o755));

    await expect(migrateRepo(root, { isWritten: false })).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it("gives each note once", async () => {
    const root = await setUp({ ".halinka/workflows/test.yml": legacyWorkflow });

    const { notes } = await migrateRepo(root, { isWritten: false });

    expect(notes).toHaveLength(1);
  });
});
