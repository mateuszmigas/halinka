import { execFile, execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { abortError } from "./errors";
import { pathExists } from "./fs";
import { type CommandResult, Git } from "./git";
import { tempFolder } from "./testing";

const identity = { "user.name": "Halinka Test", "user.email": "test@halinka.local" };

// `utils` cannot import the host sandbox, which depends on it.
const hostGit = (cwd: string, config?: Record<string, string>) =>
  new Git(
    {
      exec: ([file, ...args], { env }) =>
        new Promise<CommandResult>((resolve, reject) => {
          const options = { cwd, env: env && { ...process.env, ...env } };
          execFile(file!, args, options, (error, stdout, stderr) => {
            if (error && typeof error.code !== "number") reject(error);
            else resolve({ exitCode: error ? Number(error.code) : 0, stdout, stderr });
          });
        }),
    },
    config,
  );

const setUp = async () => {
  const root = await tempFolder();
  const folder = join(root, "repo");
  const repo = hostGit(folder, identity);
  await mkdir(folder);
  await writeFile(join(folder, "README.md"), "# Test\n");
  await repo.run("init", "--quiet");
  await repo.run("add", ".");
  await repo.run("commit", "--quiet", "-m", "Initial commit");
  return { root, folder, repo };
};

type Fixture = Awaited<ReturnType<typeof setUp>>;

const addNestedWithFilter = async ({ root, folder, repo }: Fixture) => {
  const marker = join(root, "filter-ran");
  await mkdir(join(folder, "nested"));
  const nested = hostGit(join(folder, "nested"), identity);
  await nested.run("init", "--quiet");
  await writeFile(join(folder, "nested", ".gitattributes"), "* filter=agent\n");
  await nested.run("config", "filter.agent.clean", `sh -c 'touch "${marker}"; cat'`);
  await writeFile(join(folder, "nested", "file.md"), "first\n");
  await nested.run("add", "--all");
  await nested.run("commit", "--quiet", "-m", "Nested");
  await repo.run("add", "--all");
  await repo.run("commit", "--quiet", "-m", "Gitlink");
  await writeFile(
    join(folder, ".gitmodules"),
    '[submodule "nested"]\n\tpath = nested\n\tignore = none\n',
  );
  await rm(marker, { force: true });
  await writeFile(join(folder, "nested", "file.md"), "changed\n");
  return { marker, nested };
};

const nonUtf8Name = "$(printf 'n\\377')";

const inRepo = (folder: string, script: string) =>
  execFileSync("sh", ["-c", script], { cwd: folder });

const commitNonUtf8Entry = async (
  { folder, repo }: Pick<Fixture, "folder" | "repo">,
  mode: string,
  object: string,
) => {
  inRepo(folder, `git update-index --add --cacheinfo "${mode},${object},${nonUtf8Name}"`);
  await repo.run("commit", "--quiet", "-m", "Entry");
};

describe("Git", () => {
  it("does not verify the signature of a commit that it archives", async () => {
    const { root, folder, repo } = await setUp();
    const marker = join(root, "verifier-ran");
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin", "gpg"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, {
      mode: 0o755,
    });
    await writeFile(join(folder, ".gitattributes"), "version export-subst\n");
    await writeFile(join(folder, "version"), "$Format:%G?$\n");
    await repo.run("add", "--all");
    await repo.run("commit", "--quiet", "-m", "Version");
    const tree = await repo.run("rev-parse", "HEAD^{tree}");
    const signed = [
      `tree ${tree}`,
      "author Halinka Test <test@halinka.local> 1 +0000",
      "committer Halinka Test <test@halinka.local> 1 +0000",
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " ",
      " -----END PGP SIGNATURE-----",
      "",
      "Signed",
      "",
    ].join("\n");
    await writeFile(join(root, "commit"), signed);
    const commit = await repo.run("hash-object", "-t", "commit", "-w", join(root, "commit"));
    vi.stubEnv("PATH", `${join(root, "bin")}:${process.env.PATH}`);

    await repo.archive(commit, join(root, "tree.tar"));

    expect(await pathExists(marker)).toBe(false);
  });

  it("keeps the environment of the instance in a call with its own environment", async () => {
    const envs: (Record<string, string> | undefined)[] = [];
    const executor = {
      exec: async (_: string[], { env }: { env?: Record<string, string> }) => {
        envs.push(env);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const git = new Git(executor, {}, { env: { GIT_CONFIG_NOSYSTEM: "1" } });

    await git.findRemoteBranch("https://example.invalid/repo.git", "main", {});

    expect(envs[0]).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
  });

  it("does not verify the signature of a commit that it reads", async () => {
    const { root, folder, repo } = await setUp();
    const marker = join(root, "verifier-ran");
    await writeFile(join(root, "gpg"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
    const [parent = "", tree = ""] = (await repo.run("rev-parse", "HEAD", "HEAD^{tree}")).split(
      "\n",
    );
    const signed = [
      `tree ${tree}`,
      `parent ${parent}`,
      "author Halinka Test <test@halinka.local> 1 +0000",
      "committer Halinka Test <test@halinka.local> 1 +0000",
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " ",
      " -----END PGP SIGNATURE-----",
      "",
      "Signed",
      "",
    ].join("\n");
    await writeFile(join(root, "commit"), signed);
    const commit = await repo.run("hash-object", "-t", "commit", "-w", join(root, "commit"));
    vi.stubEnv("GIT_CONFIG_COUNT", "2");
    vi.stubEnv("GIT_CONFIG_KEY_0", "log.showSignature");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "true");
    vi.stubEnv("GIT_CONFIG_KEY_1", "gpg.program");
    vi.stubEnv("GIT_CONFIG_VALUE_1", join(root, "gpg"));

    await hostGit(folder).listTrailers(parent, commit, "Halinka-Run");

    expect(await pathExists(marker)).toBe(false);
  });

  it("finds where two branches split", async () => {
    const repoFolder = await tempFolder();
    const git = hostGit(repoFolder, { "user.name": "t", "user.email": "t@example.com" });
    const commit = async (message: string) => {
      await git.run("commit", "--quiet", "--allow-empty", "-m", message);
      return git.run("rev-parse", "HEAD");
    };
    await git.run("init", "--quiet", "--initial-branch=main");
    const split = await commit("split");
    const tip = await commit("on main");
    await git.run("checkout", "--quiet", "-b", "fix", split);
    const head = await commit("on fix");

    const found = await git.readMergeBase(head, tip);

    expect(found).toBe(split);
  });

  it("finds the root of the repo from a folder in it", async () => {
    const { folder } = await setUp();
    await mkdir(join(folder, "src"));

    expect(await hostGit(join(folder, "src")).findRoot()).toBe(folder);
  });

  it("keeps the commit of a ref that exists", async () => {
    const { folder, repo } = await setUp();
    const first = await repo.run("rev-parse", "HEAD");
    await repo.createRef("refs/halinka/kept", first);
    await writeFile(join(folder, "later.md"), "later\n");
    await repo.run("add", ".");
    await repo.run("commit", "--quiet", "-m", "Later");

    await repo.createRef("refs/halinka/kept", await repo.run("rev-parse", "HEAD"));

    expect(await repo.run("rev-parse", "refs/halinka/kept")).toBe(first);
  });

  it("lists the message and the added lines of each commit, oldest first", async () => {
    const { folder, repo } = await setUp();
    const base = await repo.run("rev-parse", "HEAD");
    await writeFile(join(folder, "a.txt"), "first\n");
    await repo.run("add", ".");
    await repo.run("commit", "--quiet", "-m", "Add a");
    await writeFile(join(folder, "a.txt"), "second\n");
    await repo.run("commit", "--quiet", "-am", "Change a");
    const head = await repo.run("rev-parse", "HEAD");

    const changes = await repo.listCommitChanges(base, head, {
      maxCount: 10,
      maxOutputChars: 1024 * 1024,
    });

    expect(changes.map(({ message }) => message.trim())).toEqual(["Add a", "Change a"]);
    expect(changes[1]).toMatchObject({
      commit: head,
      changes: "diff --git a/a.txt b/a.txt\n+++ b/a.txt\n+second",
    });
  });

  it("finds no root outside a repo", async () => {
    const { root } = await setUp();

    expect(await hostGit(root).findRoot()).toBeUndefined();
  });

  it("gives the error of git when a command fails", async () => {
    const { repo } = await setUp();

    await expect(repo.run("rev-parse", "--verify", "missing")).rejects.toThrow(
      "git rev-parse failed with exit code 128: fatal: Needed a single revision",
    );
  });

  it("does not run the hooks of the repo", async () => {
    const { folder, repo } = await setUp();
    await writeFile(join(folder, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });

    await repo.run("commit", "--quiet", "--allow-empty", "-m", "Second commit");

    expect(await repo.run("rev-list", "--count", "HEAD")).toBe("2");
  });

  it("does not sign commits", async () => {
    const { repo } = await setUp();
    await repo.run("config", "user.signingkey", "missing-key");
    await repo.run("config", "commit.gpgsign", "true");

    await repo.run("commit", "--quiet", "--allow-empty", "-m", "Second commit");

    expect(await repo.run("rev-list", "--count", "HEAD")).toBe("2");
  });

  it("does not run the fsmonitor of the repo config", async () => {
    const { root, repo } = await setUp();
    const marker = join(root, "fsmonitor-ran");
    await writeFile(join(root, "fsmonitor.sh"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, {
      mode: 0o755,
    });
    await repo.run("config", "core.fsmonitor", join(root, "fsmonitor.sh"));

    await repo.listChanges();

    expect(await pathExists(marker)).toBe(false);
  });

  it("names the subcommand when the executor rejects", async () => {
    const git = new Git({ exec: () => Promise.reject(new Error("The sandbox did not answer")) });

    await expect(git.run("status")).rejects.toThrow(
      "git status failed: The sandbox did not answer",
    );
  });

  it("keeps an AbortError of the executor", async () => {
    const abort = abortError();
    const git = new Git({ exec: () => Promise.reject(abort) });

    await expect(git.run("status")).rejects.toBe(abort);
  });

  it.each([
    ["2.34.1", ["reset", "--quiet", "abc"]],
    ["2.36.0", ["reset", "--quiet", "--no-refresh", "abc"]],
  ])("resets with the refresh option that git %s knows", async (version, reset) => {
    const commands: string[][] = [];
    const git = new Git({
      exec: (command) => {
        commands.push(command.slice(command.lastIndexOf("-c") + 2));
        const stdout = command.includes("version") ? `git version ${version}\n` : "";
        return Promise.resolve({ exitCode: 0, stdout, stderr: "" });
      },
    });

    await git.restoreBranch("main", "abc");
    await git.restoreBranch("main", "abc");

    expect(commands.filter(([subcommand]) => subcommand === "version")).toHaveLength(1);
    expect(commands.filter(([subcommand]) => subcommand === "reset")).toEqual([reset, reset]);
  });

  it("refuses to commit the index when HEAD moved away from the parent", async () => {
    const { repo } = await setUp();
    const parent = await repo.run("rev-parse", "HEAD");
    await repo.run("commit", "--quiet", "--allow-empty", "-m", "Moved");

    await expect(repo.commitIndex(parent, "Checkpoint")).rejects.toThrow("git update-ref failed");
    expect(await repo.run("log", "-1", "--format=%s")).toBe("Moved");
  });

  it("lists no staged files after a commit", async () => {
    const { repo } = await setUp();

    expect(await repo.listStagedFiles(1000)).toEqual([]);
  });

  it("lists the staged files", async () => {
    const { folder, repo } = await setUp();
    await writeFile(join(folder, "notes.md"), "notes\n");
    await repo.run("add", ".");

    expect(await repo.listStagedFiles(1000)).toEqual(["notes.md"]);
  });

  it("keeps the time limit and the signal of the Git in a call with an output limit", async () => {
    const calls: unknown[] = [];
    const executor = {
      exec: (_command: string[], call: unknown) => {
        calls.push(call);
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
    };
    const { signal } = new AbortController();
    const git = new Git(executor, {}, { timeoutMs: 1000, signal });

    await git.listStagedFiles(500);

    expect(calls).toEqual([{ timeoutMs: 1000, signal, maxOutputChars: 500 }]);
  });

  it("finds the commit of a branch", async () => {
    const { repo } = await setUp();
    const head = await repo.run("rev-parse", "HEAD");
    await repo.run("branch", "feature");

    expect(await repo.findBranch("feature")).toBe(head);
  });

  it("finds no commit for a missing branch", async () => {
    const { repo } = await setUp();

    expect(await repo.findBranch("missing")).toBeUndefined();
  });

  it("throws when a query fails outside a repo", async () => {
    const { root } = await setUp();

    await expect(hostGit(root).findCommit("HEAD")).rejects.toThrow("git rev-parse failed");
  });

  it("lists the worktrees with their branches", async () => {
    const { root, folder, repo } = await setUp();
    const worktree = join(root, "worktree");
    await repo.addWorktreeWithNewBranch(worktree, "feature", "HEAD");

    expect(await repo.listWorktrees()).toEqual([
      { path: folder, branch: expect.any(String), isPrunable: false },
      { path: worktree, branch: "feature", isPrunable: false },
    ]);
  });

  it("lists a detached worktree without a branch", async () => {
    const { root, repo } = await setUp();
    const worktree = join(root, "worktree");
    await repo.run("worktree", "add", "--quiet", "--detach", worktree, "HEAD");

    expect(await repo.listWorktrees()).toContainEqual({
      path: worktree,
      branch: undefined,
      isPrunable: false,
    });
  });

  it("marks a worktree whose folder is gone as prunable", async () => {
    const { root, repo } = await setUp();
    const worktree = join(root, "worktree");
    await repo.addWorktreeWithNewBranch(worktree, "feature", "HEAD");
    await rm(worktree, { recursive: true });

    expect(await repo.listWorktrees()).toContainEqual({
      path: worktree,
      branch: "feature",
      isPrunable: true,
    });
  });

  it("lists the changed and untracked files", async () => {
    const { folder, repo } = await setUp();
    await writeFile(join(folder, "README.md"), "# Changed\n");
    await mkdir(join(folder, "docs"));
    await writeFile(join(folder, "docs", "notes.md"), "notes\n");

    expect(await repo.listChanges()).toEqual(["README.md", "docs/notes.md"]);
  });

  it("lists a staged rename by its new path", async () => {
    const { repo } = await setUp();
    await repo.run("mv", "README.md", "GUIDE.md");

    expect(await repo.listChanges()).toEqual(["GUIDE.md"]);
  });

  it("lists a path with a space without quotes", async () => {
    const { folder, repo } = await setUp();
    await writeFile(join(folder, "my notes.md"), "notes\n");

    expect(await repo.listChanges()).toEqual(["my notes.md"]);
  });

  const changedWithIgnoredFile = async () => {
    const { folder, repo } = await setUp();
    await writeFile(join(folder, ".gitignore"), "cache/\n");
    await repo.run("add", ".gitignore");
    await repo.run("commit", "--quiet", "-m", "Ignore the cache");
    await mkdir(join(folder, "cache"));
    await writeFile(join(folder, "cache", "data"), "data\n");
    await writeFile(join(folder, "README.md"), "# Changed\n");
    return { folder, repo };
  };

  it("discards the changes", async () => {
    const { repo } = await changedWithIgnoredFile();

    await repo.discardChanges();

    expect(await repo.listChanges()).toEqual([]);
  });

  it("keeps the ignored files when it discards the changes", async () => {
    const { folder, repo } = await changedWithIgnoredFile();

    await repo.discardChanges();

    expect(await readFile(join(folder, "cache", "data"), "utf8")).toBe("data\n");
  });

  it("does not run the filter of the nested repository to list the changes", async () => {
    const fixture = await setUp();
    const { marker } = await addNestedWithFilter(fixture);
    const { repo } = fixture;
    await repo.listChanges();

    expect(await pathExists(marker)).toBe(false);
  });

  it("does not run the filter of the nested repository to add all files", async () => {
    const fixture = await setUp();
    const { marker } = await addNestedWithFilter(fixture);
    const { repo } = fixture;
    await repo.addAll();

    expect(await pathExists(marker)).toBe(false);
  });

  it("keeps the commit of a gitlink when the nested repository has a later commit", async () => {
    const fixture = await setUp();
    const { nested } = await addNestedWithFilter(fixture);
    const { repo } = fixture;
    const gitlink = await repo.run("rev-parse", "HEAD:nested");
    await nested.run("commit", "--quiet", "--all", "-m", "Later");

    await repo.addAll();

    expect(await repo.run("rev-parse", ":nested")).toBe(gitlink);
  });

  it("adds the other files when the index has a gitlink", async () => {
    const fixture = await setUp();
    await addNestedWithFilter(fixture);
    const { repo } = fixture;
    await repo.addAll();

    expect(await repo.run("diff", "--cached", "--name-only")).toBe(".gitmodules");
  });

  it("lists no change for a nested repository with a later commit", async () => {
    const fixture = await setUp();
    const { nested } = await addNestedWithFilter(fixture);
    const { folder, repo } = fixture;
    await nested.run("commit", "--quiet", "--all", "-m", "Later");
    await rm(join(folder, ".gitmodules"));

    expect(await repo.listChanges()).toEqual([]);
  });

  it("adds a new nested repository as a gitlink without its filter", async () => {
    const { root, folder, repo } = await setUp();
    const marker = join(root, "filter-ran");
    await mkdir(join(folder, "nested"));
    const nested = hostGit(join(folder, "nested"), identity);
    await nested.run("init", "--quiet");
    await writeFile(join(folder, "nested", ".gitattributes"), "* filter=agent\n");
    await nested.run("config", "filter.agent.clean", `sh -c 'touch "${marker}"; cat'`);
    await nested.run("commit", "--quiet", "--allow-empty", "-m", "Nested");
    await writeFile(join(folder, "nested", "file.md"), "first\n");

    await repo.addAll();

    expect(await repo.run("ls-files", "--stage", "nested")).toMatch(/^160000 /);
    expect(await pathExists(marker)).toBe(false);
  });

  it("refuses to add all files when a gitlink has a name that is not UTF-8", async () => {
    const { folder, repo } = await setUp();
    await commitNonUtf8Entry({ folder, repo }, "160000", await repo.run("rev-parse", "HEAD"));

    await expect(repo.addAll()).rejects.toThrow("has a name that is not UTF-8");
  });

  it("refuses to restore a branch when a flagged path has a name that is not UTF-8", async () => {
    const { folder, repo } = await setUp();
    const branch = await repo.run("branch", "--show-current");
    await commitNonUtf8Entry(
      { folder, repo },
      "100644",
      await repo.run("hash-object", "-w", "README.md"),
    );
    inRepo(folder, `git update-index --assume-unchanged -- "${nonUtf8Name}"`);

    await expect(repo.restoreBranch(branch, "HEAD")).rejects.toThrow(
      "The flagged path n\uFFFD has a name that is not UTF-8",
    );
  });

  it("restores a branch in a sparse checkout with a skipped path that is not UTF-8", async () => {
    const { folder, repo } = await setUp();
    const branch = await repo.run("branch", "--show-current");
    await commitNonUtf8Entry(
      { folder, repo },
      "100644",
      await repo.run("hash-object", "-w", "README.md"),
    );
    inRepo(
      folder,
      `git config core.sparseCheckout true && git update-index --skip-worktree -- "${nonUtf8Name}"`,
    );

    await expect(repo.restoreBranch(branch, "HEAD")).resolves.toBeUndefined();
  });

  it("adds a file that the path of a gitlink matches as a glob", async () => {
    const { folder, repo } = await setUp();
    await mkdir(join(folder, "n*"));
    const nested = hostGit(join(folder, "n*"), identity);
    await nested.run("init", "--quiet");
    await nested.run("commit", "--quiet", "--allow-empty", "-m", "Nested");
    await repo.run("add", "--all");
    await repo.run("commit", "--quiet", "-m", "Gitlink");
    await writeFile(join(folder, "notes.md"), "notes\n");

    await repo.addAll();

    expect(await repo.run("diff", "--cached", "--name-only")).toBe("notes.md");
  });

  it("discards a nested repository", async () => {
    const { folder, repo } = await setUp();
    await mkdir(join(folder, "nested"));
    await hostGit(join(folder, "nested")).run("init", "--quiet");

    await repo.discardChanges();

    expect(await repo.listChanges()).toEqual([]);
  });

  it("refuses to create a branch that exists", async () => {
    const { repo } = await setUp();
    const head = await repo.run("rev-parse", "HEAD");
    await repo.createBranch("run", head);

    await expect(repo.createBranch("run", head)).rejects.toThrow("git update-ref failed");
  });

  it("refuses to move a branch that is not at the expected commit", async () => {
    const { repo } = await setUp();
    const first = await repo.run("rev-parse", "HEAD");
    await repo.run("commit", "--quiet", "--allow-empty", "-m", "Later");
    const later = await repo.run("rev-parse", "HEAD");
    await repo.createBranch("run", later);

    await expect(repo.moveBranch("run", first, first)).rejects.toThrow("git update-ref failed");
    expect(await repo.findBranch("run")).toBe(later);
  });

  it("clones only the branch, with no checkout and no shared object files", async () => {
    const { root, folder, repo } = await setUp();
    const clone = join(root, "clone");
    await repo.createBranch("run", await repo.run("rev-parse", "HEAD"));

    await repo.cloneBranch(folder, clone, "run");

    const cloned = hostGit(clone);
    expect(await cloned.run("for-each-ref", "--format=%(refname)", "refs/heads/")).toBe(
      "refs/heads/run",
    );
    expect(await cloned.run("ls-files")).toBe("");
    expect(await cloned.run("count-objects", "-v")).toContain("packs: 0");
    expect(await cloned.findGitFolder()).toBe(".git");
  });

  it("fetches a commit that no ref of the source has", async () => {
    const { root, folder, repo } = await setUp();
    const clone = join(root, "clone");
    await repo.cloneBranch(folder, clone, await repo.run("branch", "--show-current"));
    const cloned = hostGit(clone, identity);
    await cloned.run("commit", "--quiet", "--allow-empty", "-m", "Clone commit");
    const commit = await cloned.run("rev-parse", "HEAD");
    await cloned.run("reset", "--quiet", "HEAD~1");

    await repo.fetchCommit(clone, commit);

    expect(await repo.findCommit(commit)).toBe(commit);
  });
});
