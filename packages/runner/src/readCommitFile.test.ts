import { symlink } from "node:fs/promises";
import { join } from "node:path";

import { hostGit } from "@halinka/sandbox/host";
import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it } from "vitest";

import { readCommitFile } from "./readCommitFile";
import { commitAll, createRepo, writeDefinition } from "./testing";

const setUp = async () => {
  const repoPath = await createRepo();
  const git = hostGit(repoPath);
  const commitChanges = () => commitAll(repoPath, "change");
  return { repoPath, commitChanges, head: () => git.run("rev-parse", "HEAD") };
};

describe("readCommitFile", () => {
  it("reads a file of the commit, not of the working tree", async () => {
    const { repoPath, commitChanges, head } = await setUp();
    await writeDefinition(repoPath, ".devcontainer/devcontainer.json", '{ "image": "a" }\n');
    await commitChanges();
    await writeDefinition(repoPath, ".devcontainer/devcontainer.json", '{ "image": "b" }\n');
    const commit = await head();

    expect(
      await readCommitFile({ repoPath, commit, path: ".devcontainer/devcontainer.json" }),
    ).toEqual({ source: '{ "image": "a" }\n' });
  });

  it("reads a file when .halinka/ of the working tree points outside the repo", async () => {
    const { repoPath, head } = await setUp();
    await symlink(await tempFolder(), join(repoPath, ".halinka"));

    expect(await readCommitFile({ repoPath, commit: await head(), path: "README.md" })).toEqual({
      source: "README.md\n",
    });
  });

  it("gives undefined for a file that the commit does not have", async () => {
    const { repoPath, head } = await setUp();

    expect(
      await readCommitFile({ repoPath, commit: await head(), path: "missing.json" }),
    ).toBeUndefined();
  });

  it("gives undefined for a symlink", async () => {
    const { repoPath, commitChanges, head } = await setUp();
    await symlink("/etc/hosts", join(repoPath, "link.json"));
    await commitChanges();

    expect(
      await readCommitFile({ repoPath, commit: await head(), path: "link.json" }),
    ).toBeUndefined();
  });

  it("refuses a commit that the repo does not have", async () => {
    const { repoPath } = await setUp();
    const commit = "0123456789abcdef0123456789abcdef01234567";

    await expect(readCommitFile({ repoPath, commit, path: "README.md" })).rejects.toThrow(
      `has no commit ${commit}`,
    );
  });

  it("refuses a file larger than 1 MiB", async () => {
    const { repoPath, commitChanges, head } = await setUp();
    await writeDefinition(repoPath, "big.json", "x".repeat(1024 * 1024 + 1));
    await commitChanges();

    await expect(
      readCommitFile({ repoPath, commit: await head(), path: "big.json" }),
    ).rejects.toThrow("big.json is larger than 1 MiB");
  });

  it("refuses a path that leaves the repo root", async () => {
    const { repoPath, head } = await setUp();

    await expect(
      readCommitFile({ repoPath, commit: await head(), path: "../secret.json" }),
    ).rejects.toThrow('"../secret.json" is not a path from the repo root');
  });

  it("refuses a value that is not a commit id", async () => {
    const { repoPath } = await setUp();

    await expect(readCommitFile({ repoPath, commit: "HEAD", path: "README.md" })).rejects.toThrow(
      '"HEAD" is not a commit id',
    );
  });
});
