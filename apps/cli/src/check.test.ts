import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ensureFolder } from "@halinka/utils/fs";
import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it } from "vitest";

import { checkRepo } from "./check";

const write = async (root: string, path: string, content: string) => {
  await ensureFolder(dirname(join(root, path)));
  await writeFile(join(root, path), content);
};

const shellWorkflow =
  "schema_version: 1\nname: Build\nsteps:\n  - id: build\n    type: shell\n    run: make\n";

describe("checkRepo", () => {
  it("accepts a valid config with a workflow", async () => {
    const root = await tempFolder();
    await write(root, ".halinka/config.yml", "schema_version: 1\nserver: local\n");
    await write(root, ".halinka/workflows/build.yml", shellWorkflow);

    expect(await checkRepo(root)).toEqual({ workflows: 1, problems: [] });
  });

  it("gives the line of a problem in a workflow", async () => {
    const root = await tempFolder();
    await write(root, ".halinka/config.yml", "schema_version: 1\nserver: local\n");
    await write(
      root,
      ".halinka/workflows/build.yml",
      shellWorkflow.replace("id: build", "id: Not Valid"),
    );

    const { problems } = await checkRepo(root);

    expect(problems).toEqual([expect.stringMatching(/^\.halinka\/workflows\/build\.yml:4:5 /)]);
  });

  it("refuses an agent that no preset has", async () => {
    const root = await tempFolder();
    await write(root, ".halinka/config.yml", "schema_version: 1\nserver: local\n");
    await write(
      root,
      ".halinka/workflows/fix.yml",
      "schema_version: 1\nname: Fix\nsteps:\n  - id: fix\n    type: agent\n    agent: no-such-agent\n    prompt: Fix it\n",
    );

    const { problems } = await checkRepo(root);

    expect(problems).toEqual([expect.stringContaining("no-such-agent")]);
  });

  it("refuses a repo with no config", async () => {
    const root = await tempFolder();
    await write(root, ".halinka/workflows/build.yml", shellWorkflow);

    const { problems } = await checkRepo(root);

    expect(problems).toEqual([".halinka/config.yml does not exist. Run halinka init."]);
  });

  it("refuses a config that names a devcontainer with no file", async () => {
    const root = await tempFolder();
    await write(
      root,
      ".halinka/config.yml",
      "schema_version: 1\nserver: local\ndevcontainer: .devcontainer.json\n",
    );
    await write(root, ".halinka/workflows/build.yml", shellWorkflow);

    const { problems } = await checkRepo(root);

    expect(problems).toEqual([
      ".halinka/config.yml names the devcontainer .devcontainer.json, and that file does not exist.",
    ]);
  });

  it("refuses a repo with no workflow", async () => {
    const root = await tempFolder();
    await write(root, ".halinka/config.yml", "schema_version: 1\nserver: local\n");

    const { problems } = await checkRepo(root);

    expect(problems).toEqual([".halinka/workflows/ has no workflow."]);
  });

  it("accepts a config whose devcontainer file exists", async () => {
    const root = await tempFolder();
    await write(
      root,
      ".halinka/config.yml",
      "schema_version: 1\nserver: local\ndevcontainer: .devcontainer.json\n",
    );
    await write(root, ".devcontainer.json", "{}\n");
    await write(root, ".halinka/workflows/build.yml", shellWorkflow);

    expect(await checkRepo(root)).toEqual({ workflows: 1, problems: [] });
  });

  it("gives the line of a problem in the config", async () => {
    const root = await tempFolder();
    await write(
      root,
      ".halinka/config.yml",
      "schema_version: 1\nserver: local\nsetup:\n  run: make\n",
    );
    await write(root, ".halinka/workflows/build.yml", shellWorkflow);

    const { problems } = await checkRepo(root);

    expect(problems).toEqual([expect.stringMatching(/^\.halinka\/config\.yml:3:/)]);
  });

  it("reports the problems of the config and of a workflow together", async () => {
    const root = await tempFolder();
    await write(
      root,
      ".halinka/config.yml",
      "schema_version: 1\nserver: local\nsetup:\n  run: make\n",
    );
    await write(
      root,
      ".halinka/workflows/build.yml",
      shellWorkflow.replace("id: build", "id: Not Valid"),
    );

    const { problems } = await checkRepo(root);

    expect(problems).toHaveLength(2);
  });

  it("ignores a folder with the name of a workflow", async () => {
    const root = await tempFolder();
    await write(root, ".halinka/config.yml", "schema_version: 1\nserver: local\n");
    await write(root, ".halinka/workflows/build.yml", shellWorkflow);
    await write(root, ".halinka/workflows/archive.yml/old.txt", "Old\n");

    expect(await checkRepo(root)).toEqual({ workflows: 1, problems: [] });
  });

  it("ignores a file in the workflows folder that is not a workflow", async () => {
    const root = await tempFolder();
    await write(root, ".halinka/config.yml", "schema_version: 1\nserver: local\n");
    await write(root, ".halinka/workflows/readme.md", "Not a workflow\n");

    const { problems } = await checkRepo(root);

    expect(problems).toEqual([".halinka/workflows/ has no workflow."]);
  });
});
