import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { HostSandbox } from "@halinka/sandbox/host";
import { Git } from "@halinka/utils/git";
import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it } from "vitest";

import { Checkpoints } from "./checkpoints";
import { masking } from "./testing";

const branch = "halinka/run-1";
const agentIdentity = { "user.name": "Agent", "user.email": "agent@test.local" };
const attempt = { stepId: "a1", attempt: 1, summary: "Wrote the notes" };
const lentValue = "sk-lent-value-1";
const lent = masking(lentValue);

const setUp = async () => {
  const folder = await tempFolder();
  const sandbox = new HostSandbox(folder);
  const git = new Git(sandbox, agentIdentity);
  const findHead = () => git.findBranch(branch);
  await git.run("init", "--quiet", `--initial-branch=${branch}`);
  await writeFile(join(folder, "README.md"), "# Test\n");
  await git.run("add", ".");
  await git.run("commit", "--quiet", "-m", "Initial commit");
  const before = (await findHead())!;
  const run = new AbortController();
  const checkpoints = new Checkpoints({
    sandbox,
    lent,
    workflowRunId: 1,
    branch,
    signal: run.signal,
  });
  return { folder, git, checkpoints, before, run, findHead };
};

describe("Checkpoints", () => {
  it("rejects a commit with an AbortError when the run aborts", async () => {
    const { folder, checkpoints, before, run } = await setUp();
    await writeFile(join(folder, "notes.md"), "notes\n");
    run.abort();

    await expect(checkpoints.commit(before, attempt)).rejects.toThrow(
      expect.objectContaining({ name: "AbortError" }),
    );
  });

  it("refuses a repository that git finds when the agent breaks .git", async () => {
    const { folder, git, checkpoints, before } = await setUp();
    await git.run("init", "--quiet", "--bare", ".");
    await writeFile(join(folder, ".git", "HEAD"), "broken\n");

    await expect(checkpoints.commit(before, attempt)).rejects.toThrow("not a git repository");
  });

  it("keeps the commit of a nested repository in the checkpoint", async () => {
    const { folder, git, checkpoints } = await setUp();
    await mkdir(join(folder, "nested"));
    const nested = new Git(new HostSandbox(join(folder, "nested")), agentIdentity);
    await nested.run("init", "--quiet");
    await nested.run("commit", "--quiet", "--allow-empty", "-m", "First");
    await git.run("add", "--all");
    await git.run("commit", "--quiet", "-m", "Gitlink");
    const gitlink = await git.run("rev-parse", "HEAD:nested");
    await nested.run("commit", "--quiet", "--allow-empty", "-m", "Later");
    await writeFile(join(folder, "notes.md"), "notes\n");

    const { after } = await checkpoints.commit(await git.run("rev-parse", "HEAD"), attempt);

    expect(await git.run("rev-parse", `${after}:nested`)).toBe(gitlink);
  });

  it("commits the changes of the attempt on the run branch", async () => {
    const { folder, git, checkpoints, before, findHead } = await setUp();
    await writeFile(join(folder, "notes.md"), "notes\n");

    const { after } = await checkpoints.commit(before, attempt);

    expect(await findHead()).toBe(after);
    expect(await git.run("show", `${after}:notes.md`)).toBe("notes");
  });

  it("writes the step, the attempt, the summary and the trailers in the message", async () => {
    const { folder, git, checkpoints, before } = await setUp();
    await writeFile(join(folder, "notes.md"), "notes\n");

    const { after } = await checkpoints.commit(before, attempt);

    expect(await git.run("log", "-1", "--format=%an%n%B", after)).toBe(
      [
        "Halinka",
        "a1: attempt 1",
        "",
        "Wrote the notes",
        "",
        "Halinka-Run: 1",
        "Halinka-Step: a1",
        "Halinka-Attempt: 1",
      ].join("\n"),
    );
  });

  it("leaves the summary out of the message when the attempt has none", async () => {
    const { folder, git, checkpoints, before } = await setUp();
    await writeFile(join(folder, "notes.md"), "notes\n");

    const { after } = await checkpoints.commit(before, { stepId: "a1", attempt: 1 });

    expect(await git.run("log", "-1", "--format=%B", after)).toBe(
      ["a1: attempt 1", "", "Halinka-Run: 1", "Halinka-Step: a1", "Halinka-Attempt: 1"].join("\n"),
    );
  });

  it("makes no commit when the attempt changed nothing", async () => {
    const { checkpoints, before } = await setUp();
    expect(await checkpoints.commit(before, attempt)).toEqual({
      before,
      after: before,
      changedFiles: [],
    });
  });

  it("lists the changed files of the attempt, with both paths of a rename", async () => {
    const { folder, git, checkpoints, before } = await setUp();
    await writeFile(join(folder, "notes.md"), "notes\n");
    await git.run("mv", "README.md", "GUIDE.md");

    const { changedFiles } = await checkpoints.commit(before, attempt);

    expect(changedFiles.sort()).toEqual(["GUIDE.md", "README.md", "notes.md"]);
  });

  it("refuses to commit more than 10000 changed files", async () => {
    const { folder, checkpoints, before, findHead } = await setUp();
    await mkdir(join(folder, "many"));
    const names = Array.from({ length: 10_001 }, (_, index) => join(folder, "many", `${index}`));
    await Promise.all(names.map((name) => writeFile(name, "")));

    await expect(checkpoints.commit(before, attempt)).rejects.toThrow(
      "The attempt changed 10001 files. A checkpoint can hold at most 10000 files.",
    );
    expect(await findHead()).toBe(before);
  }, 20_000);

  it("names the file and the variable when a file holds a lent value", async () => {
    const { folder, checkpoints, before, findHead } = await setUp();
    await writeFile(join(folder, "notes.md"), "notes\n");
    await writeFile(join(folder, "secret.env"), `KEY=${lentValue}\n`);

    await expect(checkpoints.commit(before, attempt)).rejects.toThrow(
      "The changes in secret.env contain the value of API_KEY. Halinka does not commit a lent credential.",
    );
    expect(await findHead()).toBe(before);
  });

  it("refuses to commit a binary file that holds a lent value", async () => {
    const { folder, checkpoints, before } = await setUp();
    await writeFile(join(folder, "data.bin"), Buffer.from(`\0\0${lentValue}\0`));

    await expect(checkpoints.commit(before, attempt)).rejects.toThrow(
      "The changes in data.bin contain the value of API_KEY",
    );
  });

  it("masks the lent value in the error when the path of a file holds it", async () => {
    const { folder, checkpoints, before } = await setUp();
    await writeFile(join(folder, `${lentValue}.md`), "notes\n");

    await expect(checkpoints.commit(before, attempt)).rejects.toThrow(
      "The changes in ***.md contain the value of API_KEY",
    );
  });

  it("masks a lent value in the summary of the commit message", async () => {
    const { folder, git, checkpoints, before } = await setUp();
    await writeFile(join(folder, "notes.md"), "notes\n");

    const { after } = await checkpoints.commit(before, {
      ...attempt,
      summary: `env: KEY=${lentValue}`,
    });

    expect(await git.run("log", "-1", "--format=%b", after)).toContain("env: KEY=***");
  });

  it("refuses to commit an empty file whose name holds a lent value", async () => {
    const { folder, checkpoints, before } = await setUp();
    await writeFile(join(folder, `${lentValue}.md`), "");

    await expect(checkpoints.commit(before, attempt)).rejects.toThrow("the value of API_KEY");
  });

  it("names the file after a file that has a carriage return before `diff --git`", async () => {
    const { folder, checkpoints, before } = await setUp();
    await writeFile(join(folder, "a.txt"), "x\rdiff --git y\n");
    await writeFile(join(folder, "b.env"), `KEY=${lentValue}\n`);

    await expect(checkpoints.commit(before, attempt)).rejects.toThrow("The changes in b.env");
  });

  it("names the file after a file that the agent replaced with a symlink", async () => {
    const { folder, checkpoints, before } = await setUp();
    await rm(join(folder, "README.md"));
    await symlink("notes.md", join(folder, "README.md"));
    await writeFile(join(folder, "secret.env"), `KEY=${lentValue}\n`);

    await expect(checkpoints.commit(before, attempt)).rejects.toThrow("The changes in secret.env");
  });

  it("commits a change next to an unchanged line that holds a lent value", async () => {
    const { folder, git, checkpoints } = await setUp();
    await writeFile(join(folder, "secret.env"), `KEY=${lentValue}\nA=1\n`);
    await git.run("add", ".");
    await git.run("commit", "--quiet", "-m", "Secret");
    const start = await git.run("rev-parse", "HEAD");
    await writeFile(join(folder, "secret.env"), `KEY=${lentValue}\nA=2\n`);

    const { after } = await checkpoints.commit(start, attempt);

    expect(await git.run("show", `${after}:secret.env`)).toBe(`KEY=${lentValue}\nA=2`);
  });

  it("commits the removal of a line that holds a lent value", async () => {
    const { folder, git, checkpoints } = await setUp();
    await writeFile(join(folder, "secret.env"), `KEY=${lentValue}\n`);
    await git.run("add", ".");
    await git.run("commit", "--quiet", "-m", "Secret");
    const start = await git.run("rev-parse", "HEAD");
    await writeFile(join(folder, "secret.env"), "KEY=\n");

    const { after } = await checkpoints.commit(start, attempt);

    expect(await git.run("show", `${after}:secret.env`)).toBe("KEY=");
  });

  it("commits the changes of more than 1000 files that the agent hid", async () => {
    const { folder, git, checkpoints } = await setUp();
    await mkdir(join(folder, "many"));
    const names = Array.from({ length: 1001 }, (_, index) => `many/${index}`);
    await Promise.all(names.map((name) => writeFile(join(folder, name), "")));
    await git.run("add", ".");
    await git.run("commit", "--quiet", "-m", "Many");
    const start = await git.run("rev-parse", "HEAD");
    await git.run("update-index", "--assume-unchanged", "--", ...names);
    await Promise.all(names.map((name) => writeFile(join(folder, name), "hidden\n")));

    const { changedFiles } = await checkpoints.commit(start, attempt);

    expect(changedFiles).toHaveLength(1001);
  });

  it.each(["--skip-worktree", "--assume-unchanged"])(
    "commits a change that the agent hid with %s",
    async (flag) => {
      const { folder, git, checkpoints, before } = await setUp();
      await writeFile(join(folder, "README.md"), "# Hidden\n");
      await git.run("update-index", flag, "README.md");

      const { after } = await checkpoints.commit(before, attempt);

      expect(await git.run("show", `${after}:README.md`)).toBe("# Hidden");
    },
  );

  it("folds the commits of the agent into one commit", async () => {
    const { folder, git, checkpoints, before } = await setUp();
    await writeFile(join(folder, "notes.md"), "notes\n");
    await git.run("add", ".");
    await git.run("commit", "--quiet", "-m", "Agent commit");

    const { after } = await checkpoints.commit(before, attempt);

    expect(await git.run("rev-parse", `${after}^`)).toBe(before);
  });

  it("commits when the agent left a merge with a conflict", async () => {
    const { folder, git, checkpoints, before } = await setUp();
    await git.run("switch", "--quiet", "-c", "other");
    await writeFile(join(folder, "README.md"), "# Other\n");
    await git.run("commit", "--quiet", "-am", "Other");
    await git.run("switch", "--quiet", branch);
    await writeFile(join(folder, "README.md"), "# Run\n");
    await git.run("commit", "--quiet", "-am", "Run");
    await expect(git.run("merge", "--quiet", "other")).rejects.toThrow("git merge failed");

    const { after } = await checkpoints.commit(before, attempt);

    expect(await git.run("rev-parse", `${after}^`)).toBe(before);
  });

  it("commits on the run branch when the agent switched to another branch", async () => {
    const { folder, git, checkpoints, before, findHead } = await setUp();
    await git.run("switch", "--quiet", "-c", "feature");
    await writeFile(join(folder, "notes.md"), "notes\n");

    const { after } = await checkpoints.commit(before, attempt);

    expect(await findHead()).toBe(after);
    expect(await git.run("branch", "--show-current")).toBe(branch);
  });

  it("commits the files of a folder that the agent staged as a gitlink", async () => {
    const { folder, git, checkpoints, before } = await setUp();
    await git.run("update-index", "--add", "--cacheinfo", `160000,${before},src`);
    await mkdir(join(folder, "src"));
    await writeFile(join(folder, "src", "file.md"), "file\n");

    const committed = await checkpoints.commitChangesBefore(before, "a1", 1);

    expect(await git.run("show", `${committed}:src/file.md`)).toBe("file");
  });

  it("commits the changes in the workspace with a title for the attempt", async () => {
    const { folder, git, checkpoints, before, findHead } = await setUp();
    await writeFile(join(folder, "dist.js"), "built\n");

    const committed = await checkpoints.commitChangesBefore(before, "a1", 2);

    expect(committed).toBe(await findHead());
    expect(committed).not.toBe(before);
    expect(await git.run("log", "-1", "--format=%s")).toBe("a1: changes before attempt 2");
  });

  it("commits nothing when the workspace has no changes", async () => {
    const { checkpoints, before, findHead } = await setUp();
    expect(await checkpoints.commitChangesBefore(before, "a1", 1)).toBeUndefined();
    expect(await findHead()).toBe(before);
  });

  it("finds no changes outside the patterns of a sparse checkout", async () => {
    const { folder, git, checkpoints } = await setUp();
    await mkdir(join(folder, "src"));
    await writeFile(join(folder, "src", "app.ts"), "app\n");
    await git.run("add", ".");
    await git.run("commit", "--quiet", "-m", "App");
    const start = await git.run("rev-parse", "HEAD");
    await git.run("sparse-checkout", "set", "docs");

    expect(await checkpoints.discard(start)).toEqual([]);
  });

  it("returns the files that the agent changed", async () => {
    const { folder, checkpoints, before } = await setUp();
    await writeFile(join(folder, "README.md"), "# Changed\n");
    await mkdir(join(folder, "docs"));
    await writeFile(join(folder, "docs", "notes.md"), "notes\n");

    expect(await checkpoints.discard(before)).toEqual(["README.md", "docs/notes.md"]);
  });

  it("discards the changes of the agent", async () => {
    const { folder, git, checkpoints, before } = await setUp();
    await writeFile(join(folder, "README.md"), "# Changed\n");
    await writeFile(join(folder, "notes.md"), "notes\n");

    await checkpoints.discard(before);

    expect(await readFile(join(folder, "README.md"), "utf8")).toBe("# Test\n");
    expect(await git.listChanges()).toEqual([]);
  });

  it("discards the commits of the agent", async () => {
    const { folder, git, checkpoints, before, findHead } = await setUp();
    await writeFile(join(folder, "notes.md"), "notes\n");
    await git.run("add", ".");
    await git.run("commit", "--quiet", "-m", "Agent commit");

    expect(await checkpoints.discard(before)).toEqual(["notes.md"]);

    expect(await findHead()).toBe(before);
  });
});
