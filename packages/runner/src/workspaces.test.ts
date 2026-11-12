import { readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { ClaimedRun, SandboxTarget } from "@halinka/protocol";
import type { Sandbox } from "@halinka/sandbox";
import { HostSandbox, hostGit, stopLeftoverGroups } from "@halinka/sandbox/host";
import { ensureFolder, pathExists } from "@halinka/utils/fs";
import { tempFolder, writeFiles } from "@halinka/utils/testing";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { claimedRun, commitAll, commitFile, createRepo, identity, recordedStep } from "./testing";
import { type Located, Workspaces } from "./workspaces";

const branch = "halinka/run-1";

type ReopenOptions = { isFresh: boolean };

const setUp = async () => {
  const root = await tempFolder();
  const repoPath = await createRepo();
  const repo = hostGit(repoPath);
  const workspacesFolder = join(root, "workspaces", "server-a");
  const workspaces = new Workspaces(workspacesFolder);
  const folder = join(workspacesFolder, "run-1");
  const groupsFile = `${folder}.groups`;
  const baseSha = await repo.run("rev-parse", "HEAD");
  const run = claimedRun(1, {
    repoPath,
    baseSha,
    definitionSha: baseSha,
    lastCheckpoint: baseSha,
  }) as Located<ClaimedRun>;

  const notAWorktree = () => `${folder} is not a worktree of ${run.repoPath} on halinka/run-1`;

  const startLeftoverProcess = async () => {
    onTestFinished(() => stopLeftoverGroups(groupsFile).then(() => {}));
    return new HostSandbox(folder, groupsFile).spawn(["sleep", "30"], {
      signal: new AbortController().signal,
    });
  };

  const withReopen = async ({ isFresh }: ReopenOptions) => {
    await workspaces.prepareWorktree(run);
    const after = await commitFile(folder, "step.md");
    const tip = await commitFile(folder, "later.md");
    const rewind = {
      stepRunId: 7,
      before: run.baseSha,
      after,
      isFresh,
      hasLaterAttempts: true,
    };
    const reopened = { ...run, steps: [recordedStep], rewind };
    return { tip, reopened };
  };

  const prepareClone = async (claimed = run) => {
    const prepared = await workspaces.prepareClone(claimed);
    await workspaces.restoreClone(claimed, new HostSandbox(folder));
    return prepared;
  };

  // A checkpoint of the run has its trailer.
  const commitInClone = async (file: string) => {
    const clone = hostGit(folder, identity);
    await writeFile(join(folder, file), `${file}\n`);
    await clone.run("add", "--all");
    await clone.run("commit", "--quiet", "-m", `${file}\n\nHalinka-Run: 1`);
    return clone.run("rev-parse", "HEAD");
  };

  const setUpLaterCheckpoint = async () => {
    await prepareClone();
    await commitInClone("later.md");
    return new HostSandbox(folder);
  };

  const setUpCloneAfterTtl = async (files = ["later.md"]) => {
    await prepareClone();
    const checkpoints: string[] = [];
    for (const file of files) checkpoints.push(await commitInClone(file));
    const tip = checkpoints.at(-1)!;
    await workspaces.publish(run, new HostSandbox(folder), tip);
    await rm(folder, { recursive: true });
    return { checkpoints, reopened: { ...run, steps: [recordedStep], lastCheckpoint: tip } };
  };

  // The bundle command of the sandbox runs `script` instead.
  const sandboxWithBundle = (script: string): Sandbox => {
    const host = new HostSandbox(folder);
    return {
      workspaceFolder: folder,
      exec: (command, options) => host.exec(command, options),
      spawn: (command, options) =>
        host.spawn(command.includes("bundle") ? ["sh", "-c", script] : command, options),
      assignWorkspace: async () => {},
    };
  };

  const reopenCloneWithDraft = async () => {
    await prepareClone();
    const after = await commitInClone("step.md");
    const tip = await commitInClone("later.md");
    await workspaces.publish(run, new HostSandbox(folder), after);
    await writeFile(join(folder, "draft.md"), "draft\n");
    const rewind = {
      stepRunId: 7,
      before: run.baseSha,
      after,
      isFresh: true,
      hasLaterAttempts: true,
    };
    return { tip, reopened: { ...run, steps: [recordedStep], rewind } };
  };

  const targetOf = (spec: SandboxTarget["spec"]): Located<SandboxTarget> => ({
    workflowRunId: 1,
    kind: "worktree",
    repoPath: run.repoPath,
    isMirror: false,
    baseSha: run.baseSha,
    definitionSha: run.baseSha,
    spec,
    generation: 3,
  });

  const destroy = () => workspaces.apply(targetOf("destroyed"));
  const worktreeCount = async () => (await repo.listWorktrees()).length;

  const destroyWith = (lastCheckpoint: string) =>
    workspaces.apply({
      ...targetOf("destroyed"),
      runBranch: { name: branch, lastCheckpoint },
    });

  const commitOnRunBranch = async () => {
    await workspaces.prepareWorktree(run);
    await commitFile(folder, "output.md");
    return (await repo.findBranch(branch))!;
  };

  return {
    root,
    repo,
    run,
    workspacesFolder,
    workspaces,
    folder,
    groupsFile,
    notAWorktree,
    startLeftoverProcess,
    withReopen,
    prepareClone,
    commitInClone,
    setUpLaterCheckpoint,
    setUpCloneAfterTtl,
    sandboxWithBundle,
    reopenCloneWithDraft,
    targetOf,
    destroy,
    worktreeCount,
    destroyWith,
    commitOnRunBranch,
  };
};

const setUpMovedBackClone = async () => {
  const set = await setUp();
  await set.prepareClone();
  const unstored = await set.commitInClone("unstored.md");
  await set.workspaces.publish(set.run, new HostSandbox(set.folder), unstored);
  await set.prepareClone({ ...set.run, steps: [recordedStep] });
  return set;
};

const filterConfig = (filter: string) => `[filter "host"]\n\tsmudge = ${filter}\n`;

const hostFilterSources: [string, (root: string, filter: string) => Promise<void>][] = [
  [
    "global config",
    async (root, filter) => {
      await writeFiles(root, { global: filterConfig(filter) });
      vi.stubEnv("GIT_CONFIG_GLOBAL", join(root, "global"));
    },
  ],
  [
    "system config",
    async (root, filter) => {
      await writeFiles(root, { system: filterConfig(filter) });
      vi.stubEnv("GIT_CONFIG_SYSTEM", join(root, "system"));
    },
  ],
  [
    "template",
    async (root, filter) => {
      const templateDir = join(root, "template");
      await writeFiles(root, {
        "template/config": filterConfig(filter),
        global: `[init]\n\ttemplateDir = ${templateDir}\n`,
      });
      vi.stubEnv("GIT_CONFIG_GLOBAL", join(root, "global"));
    },
  ],
  [
    "environment",
    async (_, filter) => {
      vi.stubEnv("GIT_CONFIG_COUNT", "1");
      vi.stubEnv("GIT_CONFIG_KEY_0", "filter.host.smudge");
      vi.stubEnv("GIT_CONFIG_VALUE_0", filter);
    },
  ],
  [
    "git -c of a parent git",
    async (_, filter) => {
      vi.stubEnv("GIT_CONFIG_PARAMETERS", `'filter.host.smudge'='${filter}'`);
    },
  ],
];

const setUpRewoundClone = async () => {
  const set = await setUp();
  await set.prepareClone();
  const after = await set.commitInClone("step.md");
  const tip = await set.commitInClone("later.md");
  await set.workspaces.publish(set.run, new HostSandbox(set.folder), after);
  const rewind = {
    stepRunId: 7,
    before: set.run.baseSha,
    after,
    isFresh: true,
    hasLaterAttempts: true,
  };
  await set.prepareClone({ ...set.run, steps: [recordedStep], rewind });
  return { ...set, tip };
};

describe("Workspaces", () => {
  it("creates the worktree on the run branch at the base, not at HEAD", async () => {
    const { run, workspaces, folder } = await setUp();
    await commitFile(run.repoPath, "later.md");

    await workspaces.prepareWorktree(run);

    const worktree = hostGit(folder);
    expect(await worktree.run("branch", "--show-current")).toBe("halinka/run-1");
    expect(await worktree.run("rev-parse", "HEAD")).toBe(run.baseSha);
  });

  it("gives the index lock of the worktree and the lock of the run branch", async () => {
    const { run, workspaces, folder } = await setUp();
    const { lockFiles } = await workspaces.prepareWorktree(run);

    const gitFolder = await realpath(join(run.repoPath, ".git"));
    expect(lockFiles).toEqual([
      join(gitFolder, "worktrees", basename(folder), "index.lock"),
      join(gitFolder, "refs", "heads", "halinka/run-1.lock"),
    ]);
  });

  it("continues in the worktree that the run left", async () => {
    const { run, workspaces, folder } = await setUp();
    await workspaces.prepareWorktree(run);
    await writeFile(join(folder, "build.log"), "built\n");

    expect(await workspaces.prepareWorktree(run)).toMatchObject({ folder, isBranchCreated: false });
    expect(await readFile(join(folder, "build.log"), "utf8")).toBe("built\n");
  });

  it("stops the processes that an earlier runner left before it uses the worktree again", async () => {
    const { run, workspaces, startLeftoverProcess } = await setUp();
    await workspaces.prepareWorktree(run);
    const leftover = await startLeftoverProcess();

    await workspaces.prepareWorktree(run);

    await expect(leftover.exited).resolves.toBe(1);
  });

  it("records the process groups of its git calls for the next claim", async () => {
    const { run, workspaces, groupsFile } = await setUp();
    await workspaces.prepareWorktree(run);

    expect(await readFile(groupsFile, "utf8")).not.toBe("");
  });

  it("continues in the worktree when the workspaces folder is a symlink", async () => {
    const { root, run, workspacesFolder, workspaces } = await setUp();
    await ensureFolder(workspacesFolder);
    const linked = join(root, "linked");
    await symlink(workspacesFolder, linked);
    await workspaces.prepareWorktree(run);

    expect(await new Workspaces(linked).prepareWorktree(run)).toMatchObject({
      folder: join(linked, "run-1"),
    });
  });

  it("reports that it created the run branch", async () => {
    const { run, workspaces, folder } = await setUp();
    expect(await workspaces.prepareWorktree(run)).toMatchObject({ folder, isBranchCreated: true });
  });

  it("does not report a branch that existed as created", async () => {
    const { repo, run, workspaces, folder } = await setUp();
    await repo.run("branch", "halinka/run-1", run.baseSha);

    expect(await workspaces.prepareWorktree(run)).toMatchObject({ folder, isBranchCreated: false });
  });

  it("uses a branch at the base before the first recorded step", async () => {
    const { repo, run, workspaces, folder } = await setUp();
    await repo.run("branch", "halinka/run-1", run.baseSha);
    await commitFile(run.repoPath, "later.md");

    await workspaces.prepareWorktree(run);

    expect(await hostGit(folder).run("rev-parse", "HEAD")).toBe(run.baseSha);
  });

  it("rebuilds a lost worktree from the run branch at its last checkpoint", async () => {
    const { run, workspaces, folder } = await setUp();
    await workspaces.prepareWorktree(run);
    const checkpoint = await commitFile(folder, "build.log");
    await rm(folder, { recursive: true });

    await workspaces.prepareWorktree({ ...run, steps: [recordedStep], lastCheckpoint: checkpoint });

    expect(await hostGit(folder).run("rev-parse", "HEAD")).toBe(checkpoint);
    expect(await readFile(join(folder, "build.log"), "utf8")).toBe("build.log\n");
  });

  it("refuses a branch at another commit before the first recorded step", async () => {
    const { repo, run, workspaces, folder } = await setUp();
    await commitFile(run.repoPath, "later.md");
    await repo.run("branch", "halinka/run-1");

    await expect(workspaces.prepareWorktree(run)).rejects.toThrow(
      "is at another commit than the base of the run",
    );
    expect(await pathExists(folder)).toBe(false);
  });

  it("refuses a run with recorded steps when its branch is missing", async () => {
    const { repo, run, workspaces } = await setUp();
    await expect(workspaces.prepareWorktree({ ...run, steps: [recordedStep] })).rejects.toThrow(
      "The branch halinka/run-1 is missing",
    );
    expect(await repo.findBranch("halinka/run-1")).toBeUndefined();
  });

  it("refuses a folder that is not a worktree on the run branch", async () => {
    const { run, workspaces, folder, notAWorktree } = await setUp();
    await ensureFolder(folder);

    await expect(workspaces.prepareWorktree(run)).rejects.toThrow(notAWorktree());
  });

  it("keeps a folder that is not a worktree on the run branch", async () => {
    const { run, workspaces, folder } = await setUp();
    await ensureFolder(folder);
    await writeFile(join(folder, "notes.md"), "notes\n");

    await workspaces.prepareWorktree(run).catch(() => {});

    expect(await readFile(join(folder, "notes.md"), "utf8")).toBe("notes\n");
  });

  it("refuses a run folder whose worktree lost its .git", async () => {
    const { run, workspaces, folder, notAWorktree } = await setUp();
    await workspaces.prepareWorktree(run);
    await rm(join(folder, ".git"));

    await expect(workspaces.prepareWorktree(run)).rejects.toThrow(notAWorktree());
  });

  it("refuses a run worktree when the run branch is checked out in another folder", async () => {
    const { root, repo, run, workspaces, folder, notAWorktree } = await setUp();
    await workspaces.prepareWorktree(run);
    await hostGit(folder).run("switch", "--quiet", "--detach");
    await repo.addWorktree(join(root, "elsewhere"), "halinka/run-1");

    await expect(workspaces.prepareWorktree({ ...run, steps: [recordedStep] })).rejects.toThrow(
      notAWorktree(),
    );
  });

  it("refuses a worktree of the repo when the run branch is missing", async () => {
    const { repo, run, workspaces, folder, notAWorktree } = await setUp();
    await repo.addWorktreeWithNewBranch(folder, "other", "HEAD");

    await expect(workspaces.prepareWorktree(run)).rejects.toThrow(notAWorktree());
  });

  it("keeps a worktree of the repo when the run branch is missing", async () => {
    const { repo, run, workspaces, folder } = await setUp();
    await repo.addWorktreeWithNewBranch(folder, "other", "HEAD");

    await workspaces.prepareWorktree(run).catch(() => {});

    expect(await hostGit(folder).run("branch", "--show-current")).toBe("other");
  });

  it("resets a branch ahead of the last checkpoint", async () => {
    const { run, workspaces, folder } = await setUp();
    await workspaces.prepareWorktree(run);
    await commitFile(folder, "unstored.md");

    await workspaces.prepareWorktree({ ...run, steps: [recordedStep] });

    expect(await hostGit(folder).run("rev-parse", "HEAD")).toBe(run.lastCheckpoint);
  });

  it("keeps the files of the interrupted attempt at a reset to the last checkpoint", async () => {
    const { run, workspaces, folder } = await setUp();
    await workspaces.prepareWorktree(run);
    await commitFile(folder, "unstored.md");

    await workspaces.prepareWorktree({ ...run, steps: [recordedStep] });

    expect(await readFile(join(folder, "unstored.md"), "utf8")).toBe("unstored.md\n");
  });

  it("puts a worktree that the agent left detached back on the run branch", async () => {
    const { run, workspaces, folder } = await setUp();
    await workspaces.prepareWorktree(run);
    await hostGit(folder).run("switch", "--quiet", "--detach");

    await workspaces.prepareWorktree({ ...run, steps: [recordedStep] });

    expect(await hostGit(folder).run("branch", "--show-current")).toBe("halinka/run-1");
  });

  it("puts a worktree that the agent left on another branch back on the run branch", async () => {
    const { run, workspaces, folder } = await setUp();
    await workspaces.prepareWorktree(run);
    await hostGit(folder).run("switch", "--quiet", "-c", "agent-branch");

    await workspaces.prepareWorktree({ ...run, steps: [recordedStep] });

    expect(await hostGit(folder).run("branch", "--show-current")).toBe("halinka/run-1");
  });

  it("refuses a last checkpoint that is missing in the repo", async () => {
    const { run, workspaces } = await setUp();
    await workspaces.prepareWorktree(run);
    const missing = "0123456789abcdef0123456789abcdef01234567";

    await expect(
      workspaces.prepareWorktree({ ...run, steps: [recordedStep], lastCheckpoint: missing }),
    ).rejects.toThrow(`The last checkpoint ${missing} of halinka/run-1 is missing`);
  });

  it("refuses a branch that moved away from its last checkpoint", async () => {
    const { run, workspaces, folder } = await setUp();
    await workspaces.prepareWorktree(run);
    const checkpoint = await commitFile(folder, "checkpoint.md");
    await hostGit(folder).run("reset", "--quiet", "--hard", run.baseSha);

    await expect(
      workspaces.prepareWorktree({ ...run, steps: [recordedStep], lastCheckpoint: checkpoint }),
    ).rejects.toThrow("moved away from its last checkpoint");
  });

  it("rewinds the branch to before the step", async () => {
    const { run, workspaces, folder, withReopen } = await setUp();
    const { reopened } = await withReopen({ isFresh: true });

    await workspaces.prepareWorktree(reopened);

    expect(await hostGit(folder).run("rev-parse", "HEAD")).toBe(run.baseSha);
  });

  it("keeps the changes of a rewound step uncommitted", async () => {
    const { workspaces, folder, withReopen } = await setUp();
    const { reopened } = await withReopen({ isFresh: true });

    await workspaces.prepareWorktree(reopened);

    expect(await hostGit(folder).listChanges()).toEqual(["step.md"]);
  });

  it("keeps the uncommitted changes of a step at a rewind when no later step ran", async () => {
    const { run, workspaces, folder } = await setUp();
    await workspaces.prepareWorktree(run);
    await writeFile(join(folder, "draft.md"), "draft\n");
    const rewind = { stepRunId: 7, before: run.baseSha, after: run.baseSha, isFresh: true };

    await workspaces.prepareWorktree({
      ...run,
      steps: [recordedStep],
      rewind: { ...rewind, hasLaterAttempts: false },
    });

    expect(await hostGit(folder).listChanges()).toEqual(["draft.md"]);
  });

  it("keeps the uncommitted files on the tip in a ref when the rewind discards them", async () => {
    const { repo, workspaces, folder, withReopen } = await setUp();
    const { tip, reopened } = await withReopen({ isFresh: true });
    await writeFile(join(folder, "draft.md"), "draft\n");

    await workspaces.prepareWorktree(reopened);

    expect(await repo.run("rev-parse", "refs/halinka/superseded/server-a/1/7^")).toBe(tip);
    expect(await repo.run("show", "refs/halinka/superseded/server-a/1/7:draft.md")).toBe("draft");
  });

  it("keeps an uncommitted change that an index flag hides when the rewind discards it", async () => {
    const { repo, workspaces, folder, withReopen } = await setUp();
    const { reopened } = await withReopen({ isFresh: true });
    await writeFile(join(folder, "README.md"), "edited\n");
    await hostGit(folder).run("update-index", "--assume-unchanged", "README.md");

    await workspaces.prepareWorktree(reopened);

    expect(await repo.run("show", "refs/halinka/superseded/server-a/1/7:README.md")).toBe("edited");
  });

  it("keeps the first tip in a ref when the rewind repeats", async () => {
    const { repo, workspaces, withReopen } = await setUp();
    const { tip, reopened } = await withReopen({ isFresh: true });
    await workspaces.prepareWorktree(reopened);

    await workspaces.prepareWorktree(reopened);

    expect(await repo.run("rev-parse", "refs/halinka/superseded/server-a/1/7")).toBe(tip);
  });

  it("keeps the working tree of a reopen that has an attempt", async () => {
    const { workspaces, folder, withReopen } = await setUp();
    const { reopened } = await withReopen({ isFresh: false });
    await writeFile(join(folder, "draft.md"), "draft\n");

    await workspaces.prepareWorktree(reopened);

    expect(await hostGit(folder).listChanges()).toEqual(["draft.md", "later.md", "step.md"]);
  });

  it("rewinds a reopen that has an attempt in a new worktree", async () => {
    const { workspaces, folder, withReopen } = await setUp();
    const { reopened } = await withReopen({ isFresh: false });
    await rm(folder, { recursive: true, force: true });

    await workspaces.prepareWorktree(reopened);

    expect(await hostGit(folder).listChanges()).toEqual(["step.md"]);
  });

  it.each(hostFilterSources)(
    "runs no filter of the %s of the host in a new clone",
    async (_, setHostFilter) => {
      const { root, run, workspaces } = await setUp();
      await writeFile(join(run.repoPath, ".gitattributes"), "* filter=host\n");
      const baseSha = await commitAll(run.repoPath, "Filter");
      const marker = join(root, "filter-ran");
      // A git config file reads `;` as a comment.
      await setHostFilter(root, `touch ${marker} && cat`);

      await workspaces.prepareClone({ ...run, baseSha, lastCheckpoint: baseSha });

      expect(await pathExists(marker)).toBe(false);
    },
  );

  it("checks out the base commit in a new clone of a later checkpoint", async () => {
    const { workspaces, folder, setUpCloneAfterTtl } = await setUp();
    const { reopened } = await setUpCloneAfterTtl();

    await workspaces.prepareClone(reopened);

    expect(await pathExists(join(folder, "later.md"))).toBe(false);
  });

  it("allows setup.run in a new clone of a later checkpoint", async () => {
    const { workspaces, folder, setUpCloneAfterTtl } = await setUp();
    const { reopened } = await setUpCloneAfterTtl();
    await workspaces.prepareClone(reopened);

    expect(await workspaces.isOnBaseFiles(reopened, new HostSandbox(folder))).toBe(true);
  });

  it("restores the branch of a kept new clone", async () => {
    const { workspaces, folder, setUpCloneAfterTtl } = await setUp();
    const { reopened } = await setUpCloneAfterTtl();
    await workspaces.prepareClone(reopened);
    await workspaces.prepareClone(reopened);

    await workspaces.restoreClone(reopened, new HostSandbox(folder));

    const clone = hostGit(folder);
    expect(await clone.run("branch", "--show-current")).toBe(reopened.branch);
    expect(await clone.run("rev-parse", "HEAD")).toBe(reopened.lastCheckpoint);
    expect(await clone.listChanges()).toEqual([]);
  });

  it("rewinds a kept new clone", async () => {
    const { run, workspaces, folder, prepareClone, setUpCloneAfterTtl } = await setUp();
    const { checkpoints, reopened } = await setUpCloneAfterTtl(["step.md", "later.md"]);
    const after = checkpoints[0]!;
    const rewind = {
      stepRunId: 7,
      before: run.baseSha,
      after,
      isFresh: false,
      hasLaterAttempts: true,
    };
    const rewound = { ...reopened, lastCheckpoint: run.baseSha, rewind };
    await workspaces.prepareClone(rewound);

    await prepareClone(rewound);

    expect(await hostGit(folder).run("rev-parse", "HEAD")).toBe(run.baseSha);
    expect(await hostGit(folder).listChanges()).toEqual(["step.md"]);
    const superseded = "refs/halinka/superseded/server-a/1/7";
    expect(await hostGit(folder).findCommit(superseded)).toBe(checkpoints[1]);
  });

  it("keeps a changed file of a restored clone at the next claim", async () => {
    const { run, workspaces, folder, prepareClone, commitInClone } = await setUp();
    await prepareClone();
    const checkpoint = await commitInClone("later.md");
    await workspaces.publish(run, new HostSandbox(folder), checkpoint);
    await writeFile(join(folder, "README.md"), "edited\n");

    await prepareClone({ ...run, steps: [recordedStep], lastCheckpoint: checkpoint });

    expect(await readFile(join(folder, "README.md"), "utf8")).toBe("edited\n");
  });

  it("runs the hook of a new clone before the clone", async () => {
    const { run, workspaces, folder } = await setUp();
    const hadFolder: boolean[] = [];

    await workspaces.prepareClone(run, async () => void hadFolder.push(await pathExists(folder)));

    expect(hadFolder).toEqual([false]);
  });

  it("does not run the hook of a new clone for an existing clone", async () => {
    const { run, workspaces, prepareClone } = await setUp();
    await prepareClone();
    let calls = 0;

    await workspaces.prepareClone({ ...run, steps: [recordedStep] }, async () => void calls++);

    expect(calls).toBe(0);
  });

  it("finds that a workspace at a later checkpoint is not on the base files", async () => {
    const { run, workspaces, setUpLaterCheckpoint } = await setUp();
    const sandbox = await setUpLaterCheckpoint();

    expect(await workspaces.isOnBaseFiles(run, sandbox)).toBe(false);
  });

  it("removes the mark of setup when a person deleted the clone", async () => {
    const { workspaces, folder, prepareClone } = await setUp();
    await prepareClone();
    await workspaces.markSetUp(1);
    await rm(folder, { recursive: true });

    await prepareClone();

    expect(await workspaces.isSetUp(1)).toBe(false);
  });

  it("removes the mark of setup with the clone", async () => {
    const { run, workspaces, prepareClone } = await setUp();
    await prepareClone();
    await workspaces.markSetUp(1);

    await workspaces.deleteClone(1, run.repoPath);

    expect(await workspaces.isSetUp(1)).toBe(false);
  });

  it("removes the mark of the base files with the clone", async () => {
    const { run, workspaces, folder } = await setUp();
    await workspaces.prepareClone(run);

    await workspaces.deleteClone(1, run.repoPath);

    expect(await pathExists(`${folder}.base-files`)).toBe(false);
  });

  it("creates the run branch at the base and a clone of it without a remote", async () => {
    const { repo, run, folder, prepareClone } = await setUp();
    await commitFile(run.repoPath, "later.md");

    expect(await prepareClone()).toEqual({ folder, isBranchCreated: true });

    const clone = hostGit(folder);
    expect(await repo.findBranch("halinka/run-1")).toBe(run.baseSha);
    expect(await clone.run("rev-parse", "HEAD")).toBe(run.baseSha);
    expect(await readFile(join(folder, "README.md"), "utf8")).toBe("README.md\n");
    expect(await clone.run("remote")).toBe("");
  });

  it("keeps the git config of the new clone, not the config of a later claim", async () => {
    const { run, workspaces, folder, prepareClone } = await setUp();
    await prepareClone();
    const cloned = await readFile(join(folder, ".git", "config"), "utf8");
    await writeFile(join(folder, ".git", "config"), "[core]\n\tfsmonitor = ./agent.sh\n");

    await prepareClone({ ...run, steps: [recordedStep] });

    expect(await workspaces.readGitConfig(1)).toBe(cloned);
  });

  it("refuses to read the git config of a clone without its copy", async () => {
    const { workspaces, folder } = await setUp();
    await ensureFolder(folder);

    await expect(workspaces.readGitConfig(1)).rejects.toThrow(
      `${folder}.git-config is missing. Delete the folder ${folder}.`,
    );
  });

  it("continues in the clone that the run left", async () => {
    const { run, folder, prepareClone } = await setUp();
    await prepareClone();
    await writeFile(join(folder, "build.log"), "built\n");

    expect(await prepareClone({ ...run, steps: [recordedStep] })).toEqual({
      folder,
      isBranchCreated: false,
    });
    expect(await readFile(join(folder, "build.log"), "utf8")).toBe("built\n");
  });

  it("refuses a run branch that the checkout has checked out", async () => {
    const { repo, run, workspaces, folder } = await setUp();
    await repo.run("switch", "--quiet", "-c", "halinka/run-1");

    await expect(workspaces.prepareClone(run)).rejects.toThrow(
      `The branch halinka/run-1 of ${run.repoPath} is checked out in ${run.repoPath}`,
    );
    expect(await pathExists(folder)).toBe(false);
  });

  it("refuses a run folder that is not a clone", async () => {
    const { run, workspaces, folder } = await setUp();
    await ensureFolder(folder);

    await expect(workspaces.prepareClone(run)).rejects.toThrow(
      `${folder} is not a clone of ${run.repoPath} on halinka/run-1`,
    );
  });

  it("refuses a clone whose .git the agent replaced with a file", async () => {
    const { run, workspaces, folder, prepareClone } = await setUp();
    await prepareClone();
    await rm(join(folder, ".git"), { recursive: true });
    await writeFile(join(folder, ".git"), `gitdir: ${run.repoPath}/.git\n`);

    await expect(workspaces.prepareClone({ ...run, steps: [recordedStep] })).rejects.toThrow(
      "is not a clone",
    );
  });

  it("publishes a checkpoint of the clone to the run branch of the checkout", async () => {
    const { repo, run, workspaces, folder, prepareClone, commitInClone } = await setUp();
    await prepareClone();
    const checkpoint = await commitInClone("build.log");

    await workspaces.publish(run, new HostSandbox(folder), checkpoint);

    expect(await repo.findBranch("halinka/run-1")).toBe(checkpoint);
  });

  it("refuses to publish over a commit that the user added to the run branch", async () => {
    const { root, repo, run, workspaces, folder, prepareClone, commitInClone } = await setUp();
    await prepareClone();
    const checkpoint = await commitInClone("build.log");
    await repo.addWorktree(join(root, "user"), "halinka/run-1");
    const userCommit = await commitFile(join(root, "user"), "user.md");
    await repo.deleteWorktree(join(root, "user"));

    await expect(workspaces.publish(run, new HostSandbox(folder), checkpoint)).rejects.toThrow(
      "moved away from the run",
    );
    expect(await repo.findBranch("halinka/run-1")).toBe(userCommit);
  });

  it("removes the bundle after it publishes", async () => {
    const { run, workspaces, folder, prepareClone, commitInClone } = await setUp();
    await prepareClone();
    const checkpoint = await commitInClone("build.log");

    await workspaces.publish(run, new HostSandbox(folder), checkpoint);

    expect(await pathExists(`${folder}.bundle`)).toBe(false);
  });

  it.each([
    ["a gitfile", `printf 'gitdir: %s/.git\\n' "$PWD"`],
    [
      "a bundle with a filter",
      `printf '# v3 git bundle\\n@object-format=sha1\\n@filter=blob:none\\n\\n'`,
    ],
    [
      "a filter after a long header",
      `printf '# v3 git bundle\\n'; for i in $(seq 5000); do printf '@object-format=sha1\\n'; done; printf '@filter=blob:none\\n\\n'`,
    ],
  ])("refuses %s from the sandbox as the bundle, and removes it", async (_, script) => {
    const { repo, run, workspaces, folder, prepareClone, commitInClone, sandboxWithBundle } =
      await setUp();
    await prepareClone();
    const checkpoint = await commitInClone("build.log");

    await expect(workspaces.publish(run, sandboxWithBundle(script), checkpoint)).rejects.toThrow(
      "is not a plain git bundle",
    );
    expect(await repo.findBranch("halinka/run-1")).toBe(run.baseSha);
    expect(await pathExists(`${folder}.bundle`)).toBe(false);
  });

  it("refuses a bundle process that fails", async () => {
    const { repo, run, workspaces, prepareClone, commitInClone, sandboxWithBundle } = await setUp();
    await prepareClone();
    const checkpoint = await commitInClone("build.log");

    await expect(
      workspaces.publish(run, sandboxWithBundle("echo no >&2; exit 3"), checkpoint),
    ).rejects.toThrow("git bundle failed with exit code 3: no");
    expect(await repo.findBranch("halinka/run-1")).toBe(run.baseSha);
  });

  it("leaves the run branch alone when it publishes its tip", async () => {
    const { repo, run, workspaces, folder, prepareClone, commitInClone } = await setUp();
    await prepareClone();
    const checkpoint = await commitInClone("build.log");
    await workspaces.publish(run, new HostSandbox(folder), checkpoint);

    await workspaces.publish(run, new HostSandbox(folder), checkpoint);

    expect(await repo.findBranch("halinka/run-1")).toBe(checkpoint);
  });

  it("refuses a clone without the run branch", async () => {
    const { run, folder, prepareClone } = await setUp();
    await prepareClone();
    await hostGit(folder).run("switch", "--quiet", "--detach");
    await hostGit(folder).run("branch", "--quiet", "-D", "halinka/run-1");

    await expect(prepareClone({ ...run, steps: [recordedStep] })).rejects.toThrow(
      `The branch halinka/run-1 is missing in ${folder}`,
    );
  });

  it("refuses to publish when the run branch of the checkout is gone", async () => {
    const { repo, run, workspaces, folder, prepareClone, commitInClone } = await setUp();
    await prepareClone();
    const checkpoint = await commitInClone("build.log");
    await repo.run("branch", "--quiet", "-D", "halinka/run-1");

    await expect(workspaces.publish(run, new HostSandbox(folder), checkpoint)).rejects.toThrow(
      "moved away from the run",
    );
  });

  it("refuses a commit id from the sandbox that is an option of git", async () => {
    const { run, workspaces, folder, prepareClone } = await setUp();
    await prepareClone();

    await expect(
      workspaces.publish(run, new HostSandbox(folder), "--upload-pack=touch /tmp/x"),
    ).rejects.toThrow("is not a commit id");
  });

  it("refuses to publish to a run branch that a worktree has checked out", async () => {
    const { root, repo, run, workspaces, folder, prepareClone, commitInClone } = await setUp();
    await prepareClone();
    const checkpoint = await commitInClone("build.log");
    await repo.addWorktree(join(root, "user"), "halinka/run-1");

    await expect(workspaces.publish(run, new HostSandbox(folder), checkpoint)).rejects.toThrow(
      "is checked out in",
    );
    expect(await repo.findBranch("halinka/run-1")).toBe(run.baseSha);
  });

  it("moves the run branch of the checkout back to the last checkpoint", async () => {
    const { repo, run, folder } = await setUpMovedBackClone();

    expect(await repo.findBranch("halinka/run-1")).toBe(run.baseSha);
    expect(await hostGit(folder).run("rev-parse", "HEAD")).toBe(run.baseSha);
  });

  it("keeps the files of a clone whose run branch moves back to the last checkpoint", async () => {
    const { folder } = await setUpMovedBackClone();

    expect(await readFile(join(folder, "unstored.md"), "utf8")).toBe("unstored.md\n");
  });

  it("refuses to move the run branch back over a commit of the user", async () => {
    const { root, repo, run, workspaces, folder, prepareClone, commitInClone } = await setUp();
    await prepareClone();
    const checkpoint = await commitInClone("build.log");
    await workspaces.publish(run, new HostSandbox(folder), checkpoint);
    await repo.addWorktree(join(root, "user"), "halinka/run-1");
    const userCommit = await commitFile(join(root, "user"), "user.md");
    await repo.deleteWorktree(join(root, "user"));

    await expect(
      prepareClone({ ...run, steps: [recordedStep], lastCheckpoint: checkpoint }),
    ).rejects.toThrow("has commits after the last checkpoint that the run did not make");
    expect(await repo.findBranch("halinka/run-1")).toBe(userCommit);
  });

  it("checks out a new clone before its container starts", async () => {
    const { run, workspaces, folder } = await setUp();
    await workspaces.prepareClone(run);

    expect(await readFile(join(folder, "README.md"), "utf8")).toBe("README.md\n");
  });

  it("rebuilds a lost clone from the run branch at its last checkpoint", async () => {
    const { run, workspaces, folder, prepareClone, commitInClone } = await setUp();
    await prepareClone();
    const checkpoint = await commitInClone("build.log");
    await workspaces.publish(run, new HostSandbox(folder), checkpoint);
    await rm(folder, { recursive: true });

    await prepareClone({ ...run, steps: [recordedStep], lastCheckpoint: checkpoint });

    expect(await hostGit(folder).run("rev-parse", "HEAD")).toBe(checkpoint);
    expect(await hostGit(folder).listChanges()).toEqual([]);
  });

  it("rewinds the clone to before the step", async () => {
    const { repo, run, folder } = await setUpRewoundClone();

    expect(await repo.findBranch("halinka/run-1")).toBe(run.baseSha);
    expect(await hostGit(folder).listChanges()).toEqual(["step.md"]);
  });

  it("keeps the tip of a rewound clone in a ref of the checkout", async () => {
    const { repo, tip } = await setUpRewoundClone();

    expect(await repo.run("rev-parse", "refs/halinka/superseded/server-a/1/7")).toBe(tip);
  });

  it("keeps the uncommitted files of the clone in a ref of the clone when the rewind discards them", async () => {
    const { folder, prepareClone, reopenCloneWithDraft } = await setUp();
    const { reopened } = await reopenCloneWithDraft();

    await prepareClone(reopened);

    const clone = hostGit(folder);
    expect(await clone.run("show", "refs/halinka/superseded/server-a/1/7:draft.md")).toBe("draft");
  });

  it("keeps only the tip in the ref of the checkout when the clone has uncommitted files", async () => {
    const { repo, prepareClone, reopenCloneWithDraft } = await setUp();
    const { tip, reopened } = await reopenCloneWithDraft();

    await prepareClone(reopened);

    expect(await repo.run("rev-parse", "refs/halinka/superseded/server-a/1/7")).toBe(tip);
  });

  it("commits the uncommitted files of the clone as Halinka", async () => {
    const { folder, prepareClone, reopenCloneWithDraft } = await setUp();
    const { reopened } = await reopenCloneWithDraft();

    await prepareClone(reopened);

    const clone = hostGit(folder);
    expect(
      await clone.run("log", "-1", "--format=%an", "refs/halinka/superseded/server-a/1/7"),
    ).toBe("Halinka");
  });

  it("removes a clone whose .git the agent replaced with a file", async () => {
    const { run, workspaces, folder, prepareClone } = await setUp();
    await prepareClone();
    await rm(join(folder, ".git"), { recursive: true });
    await writeFile(join(folder, ".git"), `gitdir: ${run.repoPath}/.git\n`);

    await workspaces.deleteClone(1, run.repoPath);

    expect(await pathExists(folder)).toBe(false);
  });

  it("removes the clone with its git config", async () => {
    const { run, workspaces, folder, prepareClone } = await setUp();
    await prepareClone();

    await workspaces.deleteClone(1, run.repoPath);

    expect(await pathExists(folder)).toBe(false);
    expect(await pathExists(`${folder}.git-config`)).toBe(false);
  });

  it("keeps the run branch when it removes the clone", async () => {
    const { repo, run, workspaces, prepareClone } = await setUp();
    await prepareClone();

    await workspaces.deleteClone(1, run.repoPath);

    expect(await repo.findBranch("halinka/run-1")).toBe(run.baseSha);
  });

  it("stops the processes that an earlier runner left before it uses the clone again", async () => {
    const { run, startLeftoverProcess, prepareClone } = await setUp();
    await prepareClone();
    const leftover = await startLeftoverProcess();

    await prepareClone({ ...run, steps: [recordedStep] });

    await expect(leftover.exited).resolves.toBe(1);
  });

  it("leaves no groups file after it removes the clone", async () => {
    const { run, workspaces, folder, prepareClone } = await setUp();
    await prepareClone();

    await workspaces.deleteClone(1, run.repoPath);

    expect(await pathExists(`${folder}.groups`)).toBe(false);
  });

  it("stops the processes that an earlier runner left before it removes the clone", async () => {
    const { run, workspaces, startLeftoverProcess, prepareClone } = await setUp();
    await prepareClone();
    const leftover = await startLeftoverProcess();

    await workspaces.deleteClone(1, run.repoPath);

    await expect(leftover.exited).resolves.toBe(1);
  });

  it("removes the refs of a clone when the workspaces folder does not exist", async () => {
    const { repo, run, workspaces } = await setUp();
    await repo.createRef("refs/halinka/superseded/server-a/1/1", run.baseSha);

    await workspaces.deleteClone(1, run.repoPath);

    expect(await repo.findCommit("refs/halinka/superseded/server-a/1/1")).toBeUndefined();
  });

  it.each([
    ["worktree", "prepareWorktree"],
    ["clone", "prepareClone"],
  ] as const)("makes a %s from a bare clone", async (_kind, prepare) => {
    const { root, repo, run, workspaces } = await setUp();
    const repoPath = join(root, "clone.git");
    await repo.run("clone", "--quiet", "--bare", run.repoPath, repoPath);

    const { folder: made, isBranchCreated } = await workspaces[prepare]({ ...run, repoPath });

    expect(isBranchCreated).toBe(true);
    expect(await hostGit(made).findCommit("HEAD")).toBe(run.baseSha);
    expect(await hostGit(repoPath).findBranch(run.branch)).toBe(run.baseSha);
  });

  it("finds the worktree of a kept spec as stopped", async () => {
    const { run, workspaces, targetOf } = await setUp();
    await workspaces.prepareWorktree(run);

    expect(await workspaces.apply(targetOf("stopped"))).toBe("stopped");
  });

  it("stops the processes that an earlier runner left when it applies a kept spec", async () => {
    const { run, workspaces, startLeftoverProcess, targetOf } = await setUp();
    await workspaces.prepareWorktree(run);
    const leftover = await startLeftoverProcess();

    await workspaces.apply(targetOf("stopped"));

    await expect(leftover.exited).resolves.toBe(1);
  });

  it("finds a run without a worktree as absent", async () => {
    const { workspaces, targetOf } = await setUp();
    expect(await workspaces.apply(targetOf("stopped"))).toBe("absent");
  });

  it("refuses a run id that is not a number", async () => {
    const { workspaces } = await setUp();
    expect(() => workspaces.folderOf("x/../../victim" as unknown as number)).toThrow(
      "not a number",
    );
  });

  it("reports the removed worktree of a destroyed spec as absent", async () => {
    const { run, workspaces, destroy } = await setUp();
    await workspaces.prepareWorktree(run);

    expect(await destroy()).toBe("absent");
  });

  it("finds a destroyed run as absent when the workspaces folder does not exist", async () => {
    const { destroy } = await setUp();
    expect(await destroy()).toBe("absent");
  });

  it("leaves no groups file after it removes the worktree", async () => {
    const { run, workspaces, folder, destroy } = await setUp();
    await workspaces.prepareWorktree(run);

    await destroy();

    expect(await pathExists(`${folder}.groups`)).toBe(false);
  });

  it("stops the processes that an earlier runner left before it removes the worktree", async () => {
    const { run, workspaces, startLeftoverProcess, destroy } = await setUp();
    await workspaces.prepareWorktree(run);
    const leftover = await startLeftoverProcess();

    await destroy();

    await expect(leftover.exited).resolves.toBe(1);
  });

  it("removes the worktree with its changes", async () => {
    const { run, workspaces, folder, destroy, worktreeCount } = await setUp();
    await workspaces.prepareWorktree(run);
    await writeFile(join(folder, "draft.md"), "draft\n");

    await destroy();

    expect(await pathExists(folder)).toBe(false);
    expect(await worktreeCount()).toBe(1);
  });

  it("keeps the run branch when it removes the worktree", async () => {
    const { repo, run, workspaces, destroy } = await setUp();
    await workspaces.prepareWorktree(run);

    await destroy();

    expect(await repo.findBranch("halinka/run-1")).toBe(run.baseSha);
  });

  it.each(["refs/heads/kept", "refs/remotes/origin/kept", "refs/tags/kept"])(
    "deletes the run branch of a destroyed run when %s holds its tip",
    async (ref) => {
      const { repo, destroyWith, commitOnRunBranch } = await setUp();
      const tip = await commitOnRunBranch();
      await repo.run("update-ref", ref, tip);

      await destroyWith(tip);

      expect(await repo.findBranch(branch)).toBeUndefined();
    },
  );

  it("deletes the only copy of the run branch in a bare clone", async () => {
    const { root, repo, run, workspaces, folder, targetOf } = await setUp();
    const repoPath = join(root, "clone.git");
    await repo.run("clone", "--quiet", "--bare", run.repoPath, repoPath);
    await workspaces.prepareWorktree({ ...run, repoPath });
    const tip = await commitFile(folder, "output.md");

    await workspaces.apply({
      ...targetOf("destroyed"),
      repoPath,
      runBranch: { name: branch, lastCheckpoint: tip },
    });

    expect(await hostGit(repoPath).findBranch(branch)).toBeUndefined();
  });

  it("keeps the run branch when it is the only copy", async () => {
    const { repo, destroyWith, commitOnRunBranch } = await setUp();
    const tip = await commitOnRunBranch();

    await destroyWith(tip);

    expect(await repo.findBranch(branch)).toBe(tip);
  });

  it("keeps the run branch when it moved after the last checkpoint", async () => {
    const { repo, run, destroyWith, commitOnRunBranch } = await setUp();
    const tip = await commitOnRunBranch();
    await repo.createBranch("kept", tip);

    await destroyWith(run.baseSha);

    expect(await repo.findBranch(branch)).toBe(tip);
  });

  it("keeps the run branch that a person has checked out", async () => {
    const { repo, workspaces, targetOf, destroyWith, commitOnRunBranch } = await setUp();
    const tip = await commitOnRunBranch();
    await repo.createBranch("kept", tip);
    await workspaces.apply(targetOf("destroyed"));
    await repo.run("switch", "--quiet", branch);

    await destroyWith(tip);

    expect(await repo.findBranch(branch)).toBe(tip);
  });

  it("keeps one of two run branches at one tip when both go at one time", async () => {
    const { repo, run, workspaces, targetOf, commitOnRunBranch } = await setUp();
    const tip = await commitOnRunBranch();
    await workspaces.apply(targetOf("destroyed"));
    await repo.createBranch("other", tip);

    await Promise.all([
      workspaces.deleteClone(1, run.repoPath, { name: branch, lastCheckpoint: tip }),
      workspaces.deleteClone(2, run.repoPath, { name: "other", lastCheckpoint: tip }),
    ]);

    const tips = [await repo.findBranch(branch), await repo.findBranch("other")];
    expect(tips).toContain(tip);
  });

  it("deletes the run branch after it removed the clone", async () => {
    const { repo, run, workspaces, targetOf, commitOnRunBranch } = await setUp();
    const tip = await commitOnRunBranch();
    await repo.createBranch("kept", tip);
    await workspaces.apply(targetOf("destroyed"));

    await workspaces.deleteClone(1, run.repoPath, { name: branch, lastCheckpoint: tip });

    expect(await repo.findBranch(branch)).toBeUndefined();
  });

  it("prunes the worktree of a folder that is gone", async () => {
    const { run, workspaces, folder, destroy, worktreeCount } = await setUp();
    await workspaces.prepareWorktree(run);
    await rm(folder, { recursive: true, force: true });

    await destroy();

    expect(await worktreeCount()).toBe(1);
  });

  it("removes the superseded refs of a destroyed run only", async () => {
    const { repo, run, destroy } = await setUp();
    await repo.run("update-ref", "refs/halinka/superseded/server-a/1/7", run.baseSha);
    await repo.run("update-ref", "refs/halinka/superseded/server-a/2/8", run.baseSha);

    await destroy();

    expect(await repo.run("for-each-ref", "--format=%(refname)", "refs/halinka/")).toBe(
      "refs/halinka/superseded/server-a/2/8",
    );
  });

  it("keeps the superseded refs of a run of another server", async () => {
    const { repo, run, destroy } = await setUp();
    await repo.run("update-ref", "refs/halinka/superseded/server-b/1/7", run.baseSha);

    await destroy();

    expect(await repo.findCommit("refs/halinka/superseded/server-b/1/7")).toBe(run.baseSha);
  });

  it("removes the folder when the repo is gone", async () => {
    const { run, workspaces, folder, destroy } = await setUp();
    await workspaces.prepareWorktree(run);
    await rm(run.repoPath, { recursive: true, force: true });

    await destroy();

    expect(await pathExists(folder)).toBe(false);
  });

  it("refuses to destroy a folder that is not a worktree of the repo", async () => {
    const { folder, destroy } = await setUp();
    await ensureFolder(folder);

    await expect(destroy()).rejects.toThrow("git worktree failed");
    expect(await pathExists(folder)).toBe(true);
  });
});
