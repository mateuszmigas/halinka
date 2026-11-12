import { basename } from "node:path";

import { agentPresets } from "@halinka/presets";
import { fencedText, isRunResult, type RepoFile } from "@halinka/protocol";
import { hashOf } from "@halinka/utils/hash";
import { maxFileMib, mib } from "@halinka/utils/repoFiles";
import {
  findWorkflowFile,
  isWorkflowPath,
  isWorkflowRef,
  networkHosts,
  nextCronTime,
  parseRepoConfig,
  parseWorkflow,
  repoConfigPath,
  toWorkflowPath,
} from "@halinka/workflow";

import {
  type ConnectedRunners,
  requireKnownRunner,
  requireRunner,
  wakeProcesses,
} from "../connectedRunners";
import type { Db } from "../db/client";
import { inTransaction, type Repositories } from "../db/repositories";
import { type DbRepo, isLocalRepo } from "../db/schema";
import { deleteRunOfRevokedRunner } from "../deletion";
import { publishDraft, readCommitFile, readDefinitions } from "../githubApi";
import { isLockNotAvailable } from "../planeErrors";
import { inRunTransaction, type RunBus } from "../runBus";
import { withoutNulls } from "../withoutNulls";
import type { GitHubAppService } from "./githubAppService";
import { invalidWorkflow, noRepo, ServiceError } from "./serviceError";

type RunnerOf = ReturnType<typeof requireRunner>;

// `origin`: the server URL that the request used
type RepoInit = { runnerId: number; path: string; devcontainer?: string; origin: string };

type RepoServiceOptions = {
  db: Db;
  repositories: Repositories;
  connectedRunners: ConnectedRunners;
  bus: RunBus;
  gitHubApp: GitHubAppService;
  localRunnerId: () => number | undefined;
};

const noAppAccess = () =>
  new ServiceError("BAD_REQUEST", "The App has no access to this GitHub repo");

const requireLocal = (repo: DbRepo) => {
  if (!isLocalRepo(repo)) {
    throw new ServiceError("CONFLICT", `${repo.name} is on GitHub. Change its files there.`);
  }
  return repo;
};

const draftText = (path: string, login: string) => ({
  title: "Publish a workflow draft",
  body: fencedText(
    "Published from a draft in Halinka.",
    `${path}\nRequested by ${login}`,
  ).trimEnd(),
});

type ParsedReadOptions = {
  head: string;
  defaultBranch: string | undefined;
  path: string;
  config: RepoFile | undefined;
};

type DraftOptions = { workflow: string; source: string; baseHash: string };

type WriteWorkflowOptions = { workflow: string; source: string; hash?: string };

const parsedWorkflow = (source: string) => {
  const parsed = parseWorkflow(source, { agents: agentPresets });
  return parsed.ok
    ? { workflow: parsed.value, problems: [] }
    : { workflow: undefined, problems: parsed.problems };
};

const parsedRead = (file: RepoFile, options: ParsedReadOptions) => ({
  ...options,
  ...file,
  ...parsedWorkflow(file.source),
});

export type WorkflowRead = ReturnType<typeof parsedRead>;

export const nextFireAfter = (schedule: string, after: Date) => {
  const next = nextCronTime(schedule, after);
  if (!next) throw new Error(`The schedule ${schedule} has no next time`);
  return next;
};

const workflowFiles = (files: Record<string, RepoFile>) =>
  Object.entries(files)
    .filter(([path]) => isWorkflowPath(path))
    .sort(([a], [b]) => (a < b ? -1 : 1));

export class RepoService {
  private readonly scheduleSyncs = new Map<number, Promise<unknown>>();

  constructor(private readonly options: RepoServiceOptions) {}

  async list() {
    return (await this.options.repositories.repo.list()).map(withoutNulls);
  }

  async register(runnerId: number, path: string) {
    const runner = await requireKnownRunner(
      this.options.repositories,
      this.options.connectedRunners,
      runnerId,
    );
    return this.registerOn(runner, runnerId, path);
  }

  private async registerOn(runner: RunnerOf, runnerId: number, path: string) {
    const { realPath, files } = await runner.readRepo({ repoPath: path });
    if (files[repoConfigPath] === undefined) {
      const devcontainers = await runner.listDevcontainers({ repoPath: path });
      throw new ServiceError("REPO_NOT_SET_UP", `${path} has no ${repoConfigPath}`, {
        devcontainers,
      });
    }
    // A symlink path and the real path give one row.
    const repo = await this.options.repositories.repo.register({
      name: basename(realPath),
      path: realPath,
      runnerId,
    });
    if (repo.deletingAt) {
      throw new ServiceError(
        "CONFLICT",
        `The repo ${realPath} is being deleted. Register it again after the runner removed its workspaces.`,
      );
    }
    return withoutNulls(repo);
  }

  async createGitHub(githubRepoId: number) {
    const { gitHubApp, repo } = this.options.repositories;
    const stored = await gitHubApp.findRepo(githubRepoId);
    if (!stored) throw noAppAccess();
    const name = `${stored.owner}/${stored.name}`;
    const added = await repo.createGitHub({ name, githubRepoId });
    if (added.deletingAt) {
      throw new ServiceError(
        "CONFLICT",
        `The repo ${name} is being deleted. Add it again after the runners removed its workspaces.`,
      );
    }
    // The next push reads again.
    await this.syncSchedules(added.id).catch((error: unknown) => console.error(error));
    return withoutNulls(added);
  }

  // The local runner's repo uses `server: local`, as `halinka start` registers it.
  async init({ runnerId, path, devcontainer, origin }: RepoInit) {
    const runner = await requireKnownRunner(
      this.options.repositories,
      this.options.connectedRunners,
      runnerId,
    );
    const server = runnerId === this.options.localRunnerId() ? "local" : origin;
    await runner.setUpRepo({ repoPath: path, server, devcontainer });
    return this.registerOn(runner, runnerId, path);
  }

  async delete(id: number) {
    const { isDeleted, runnerIds } = await inRunTransaction(
      this.options.db,
      this.options.bus,
      async (repositories, changed) => {
        const { repo, workflowRun } = repositories;
        const locked = await repo.lockById(id, "update");
        if (!locked || locked.deletingAt) {
          throw noRepo(id);
        }
        const activeRun = new ServiceError(
          "CONFLICT",
          `A run of the repo ${id} is active. Cancel it first.`,
        );
        // A leased write holds a run and then the repo, so a wait here can deadlock.
        const runs = await workflowRun.lockByRepo(id).catch((error: unknown) => {
          throw isLockNotAvailable(error) ? activeRun : error;
        });
        if (!runs.every(({ status }) => isRunResult(status))) throw activeRun;
        await repo.markDeleting(id);
        for (const run of runs) {
          changed(run.id, "state");
          await workflowRun.markDeleting(run.id);
          if (!(await deleteRunOfRevokedRunner(repositories, run))) {
            await workflowRun.deleteIfGone(run.id);
          }
        }
        const runnerIds = new Set(runs.flatMap(({ runnerId }) => runnerId ?? []));
        return { isDeleted: (await repo.deleteIfGone(id)) !== undefined, runnerIds };
      },
    );
    if (!isDeleted) {
      for (const runnerId of runnerIds) wakeProcesses(this.options.connectedRunners, runnerId);
    }
    return { id, isDeleted };
  }

  async linkGitHub(id: number, githubRepoId: number | null) {
    const { gitHubApp, repo } = this.options.repositories;
    const found = await this.findRepo(id);
    if (!isLocalRepo(found)) throw new ServiceError("BAD_REQUEST", `${found.name} needs no link`);
    if (
      githubRepoId !== null &&
      (await gitHubApp.findInstallationByRepo(githubRepoId)) === undefined
    ) {
      throw noAppAccess();
    }
    const linked = await repo.setGitHubRepo(id, githubRepoId);
    if (!linked) throw noRepo(id);
    return withoutNulls(linked);
  }

  private async findRepo(id: number) {
    const repo = await this.options.repositories.repo.findById(id);
    if (!repo) throw noRepo(id);
    return repo;
  }

  private readAccess({ githubRepoId }: DbRepo) {
    return this.options.gitHubApp.requireRepoToken(githubRepoId, "read");
  }

  async read(id: number) {
    const repo = await this.findRepo(id);
    if (!isLocalRepo(repo)) return readDefinitions(await this.readAccess(repo));
    const read = await requireRunner(this.options.connectedRunners, repo.runnerId).readRepo({
      repoPath: repo.path,
    });
    return { ...read, defaultBranch: undefined };
  }

  async readWorkflow(id: number, workflow: string) {
    if (!isWorkflowRef(workflow)) {
      throw new ServiceError(
        "BAD_REQUEST",
        "Use a workflow name, a file name or a path in .halinka/workflows/",
      );
    }
    const { files, ...tip } = await this.read(id);
    const found = findWorkflowFile(files, workflow);
    if (!found) throw new ServiceError("NOT_FOUND", `There is no workflow ${workflow}`);
    return parsedRead(found.file, { ...tip, path: found.path, config: files[repoConfigPath] });
  }

  // Refuses a draft of an older file: the portal then asks the person what to do.
  async readDraft(id: number, { workflow, source, baseHash }: DraftOptions) {
    const read = await this.readWorkflow(id, workflow);
    if (read.hash !== baseHash) {
      throw new ServiceError("CONFLICT", `The file ${read.path} changed after this draft started`);
    }
    if (Buffer.byteLength(source) > maxFileMib * mib) {
      throw new ServiceError("BAD_REQUEST", `The draft is larger than ${maxFileMib} MiB`);
    }
    const { head, defaultBranch, path, config } = read;
    return parsedRead({ source, hash: hashOf(source) }, { head, defaultBranch, path, config });
  }

  async publishWorkflow(id: number, draft: DraftOptions, login: string) {
    const { source, baseHash } = draft;
    const repo = await this.findRepo(id);
    if (isLocalRepo(repo)) {
      throw new ServiceError("CONFLICT", `${repo.name} is local. Save the file in its checkout.`);
    }
    const { head, path, hash, workflow: parsed, problems } = await this.readDraft(id, draft);
    if (!parsed) throw invalidWorkflow(path, problems);
    if (hash === baseHash) {
      throw new ServiceError("CONFLICT", `The draft of ${path} is the same as the file`);
    }
    const access = await this.options.gitHubApp.requireRepoToken(repo.githubRepoId, "publishDraft");
    const branch = `halinka/draft-${hashOf([path, baseHash, source].join("\0")).slice(0, 32)}`;
    const url = await publishDraft(access, { head, path, source, branch }, draftText(path, login));
    if (!url.startsWith("https://github.com/")) {
      throw new ServiceError("BAD_REQUEST", "GitHub gave a URL outside github.com");
    }
    return { url };
  }

  async readWorkflows(id: number) {
    const { files, ...tip } = await this.read(id);
    return workflowFiles(files).map(([path, file]) =>
      parsedRead(file, { ...tip, path, config: files[repoConfigPath] }),
    );
  }

  // One at a time per repo: a read that starts later sees a newer tip, and writes last.
  syncSchedules(id: number, now = new Date()) {
    const work = (this.scheduleSyncs.get(id) ?? Promise.resolve()).then(() =>
      this.readAndWriteSchedules(id, now),
    );
    const settled: Promise<unknown> = work
      .catch(() => {})
      .finally(() => {
        if (this.scheduleSyncs.get(id) === settled) this.scheduleSyncs.delete(id);
      });
    this.scheduleSyncs.set(id, settled);
    return work;
  }

  // A file that is not valid keeps its row, so its next fire records the problem.
  private async readAndWriteSchedules(id: number, now: Date) {
    const reads = await this.readWorkflows(id);
    const schedules = reads.flatMap(({ path, workflow }) => {
      const schedule = workflow?.on?.cron?.schedule;
      return schedule ? [{ path, schedule, nextFireAt: nextFireAfter(schedule, now) }] : [];
    });
    const notValid = reads.filter(({ workflow }) => !workflow).map(({ path }) => path);
    await inTransaction(this.options.db, ({ workflowSchedule }) =>
      workflowSchedule.rewrite(id, schedules, notValid),
    );
    return reads;
  }

  // The container build reads this commit, not the working tree.
  async readDevcontainer(id: number, commit: string, config: RepoFile | undefined) {
    if (!config) return undefined;
    const parsed = parseRepoConfig(config.source);
    if (!parsed.ok) {
      const problems = parsed.problems.map(({ line, message }) => `line ${line}: ${message}`);
      throw new ServiceError(
        "BAD_REQUEST",
        `${repoConfigPath} is not valid: ${problems.join("; ")}`,
      );
    }
    const { devcontainer: path, setup } = parsed.value;
    if (!path) return undefined;
    const repo = await this.findRepo(id);
    const file = isLocalRepo(repo)
      ? await requireRunner(this.options.connectedRunners, repo.runnerId).readCommitFile({
          repoPath: repo.path,
          commit,
          path,
        })
      : await readCommitFile(await this.readAccess(repo), commit, path);
    return {
      path,
      source: file?.source,
      setupNetwork: networkHosts(setup?.network),
      setupRun: setup?.run,
      setupSecrets: setup?.secrets,
      setupDocker: setup?.docker,
    };
  }

  async writeWorkflow(id: number, { workflow, source, hash }: WriteWorkflowOptions) {
    const path = toWorkflowPath(workflow);
    if (!path) {
      throw new ServiceError(
        "BAD_REQUEST",
        "Use a workflow file name or a path in .halinka/workflows/",
      );
    }
    const repo = requireLocal(await this.findRepo(id));
    const written = await requireRunner(this.options.connectedRunners, repo.runnerId).writeRepoFile(
      {
        repoPath: repo.path,
        path,
        source,
        expectedHash: hash,
      },
    );
    return { path, hash: written.hash };
  }

  async listWorkflows(id: number) {
    const { files } = await this.read(id);
    const config = files[repoConfigPath];
    const parsedConfig = config && parseRepoConfig(config.source);
    return {
      configProblems: parsedConfig && !parsedConfig.ok ? parsedConfig.problems : [],
      workflows: workflowFiles(files).map(([path, { source }]) => {
        const { workflow, problems } = parsedWorkflow(source);
        return workflow
          ? { path, name: workflow.name, inputs: workflow.inputs ?? {}, problems }
          : { path, problems };
      }),
    };
  }
}
