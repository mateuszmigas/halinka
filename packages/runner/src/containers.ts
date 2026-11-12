import { execFile } from "node:child_process";
import { mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { SandboxObservation, SandboxTarget } from "@halinka/protocol";
import {
  agentUser,
  attachDevcontainer,
  inspectAttach,
  type ContainerLimits,
  inspectContainerProcesses,
  type DevcontainerOptions,
  type DevcontainerStatus,
  EgressPolicy,
  inspectDevcontainer,
  inspectDevcontainers,
  type EgressPolicyOptions,
  reclaimWorkspace,
  deleteDevcontainer,
  stopDevcontainer,
  upDevcontainer,
} from "@halinka/sandbox/devcontainer";
import { hostGit } from "@halinka/sandbox/host";
import { errorMessage } from "@halinka/utils/errors";
import {
  ensureFolder,
  findRealPath,
  isFile,
  isRealPathInside,
  pathExists,
} from "@halinka/utils/fs";
import { noHostConfig, shortSha } from "@halinka/utils/git";
import { hashOf } from "@halinka/utils/hash";
import { backoffMs } from "@halinka/utils/retry";

import type { ProxyCredentials } from "./credentials";
import { type Located, runFolderName, type Workspaces } from "./workspaces";

const run = promisify(execFile);

export const setUpTimeoutMs = 10 * 60_000;

// The build of an image and the lifecycle commands can take long.
const startTimeoutMs = 30 * 60_000;

const npmRegistry = "registry.npmjs.org";

const writeBackoff = { initialDelayMs: 5000, maxDelayMs: 5 * 60_000 };

// Root reads no `.npmrc` of the workspace and writes no file into the npm cache of the remote user.
const setUpScript = `
set -e
cd /
command -v git >/dev/null || { echo "The devcontainer has no git. Add git to its image." >&2; exit 1; }
git config --system --get-all safe.directory | grep -qx '\\*' || git config --system --add safe.directory '*'
[ $# -eq 0 ] || command -v node >/dev/null || { echo "The devcontainer has no node, which the agents need. Use an image with node 20 or later, or add the node Feature." >&2; exit 1; }
if [ $# -gt 0 ] && ! id ${agentUser} >/dev/null 2>&1; then
  if command -v useradd >/dev/null; then useradd --create-home --shell /bin/sh --user-group ${agentUser}
  elif command -v adduser >/dev/null; then adduser -D -s /bin/sh ${agentUser}
  else echo "The devcontainer has no useradd or adduser, which the agents need to have their own user." >&2; exit 1
  fi
fi
missing=""
while [ $# -gt 0 ]; do command -v "$1" >/dev/null || missing="$missing $2"; shift 2; done
[ -z "$missing" ] || npm install --global --no-fund --no-audit --cache /root/.npm $missing >&2
`;

export type ContainerRun = Pick<
  Located<SandboxTarget>,
  | "workflowRunId"
  | "repoPath"
  | "isMirror"
  | "definitionSha"
  | "devcontainer"
  | "setupNetwork"
  | "setupDocker"
>;

export type AgentPackage = { command: string; package: string };

export type ContainerTree = Pick<DevcontainerOptions, "treeFolder" | "configPath">;

export type ContainerSpec = Pick<
  DevcontainerOptions,
  "name" | "workspaceFolder" | "treeFolder" | "configPath" | "setupNetwork" | "isDockerInside"
> & { gitConfig: string; agents: AgentPackage[]; proxy?: ProxyCredentials };

type StartOptions = { tree: ContainerTree; agents?: AgentPackage[]; proxy?: ProxyCredentials };

export type ContainersOptions = Omit<EgressPolicyOptions, "credentials"> & {
  machineCredentials?: ProxyCredentials;
  limits?: ContainerLimits;
  featurePublishers?: string[];
};

type ContainerWorkspaces = Pick<Workspaces, "folderOf" | "readGitConfig" | "deleteClone">;

export class Containers {
  private readonly policies = new Map<number, EgressPolicy>();
  private readonly retries = new Map<number, NodeJS.Timeout>();

  // Runners can share a Docker daemon, and each server numbers its runs from 1.
  private readonly runnerHash: string;

  private constructor(
    private readonly folder: string,
    private readonly workspaces: ContainerWorkspaces,
    private readonly options: ContainersOptions,
  ) {
    this.runnerHash = hashOf(folder).slice(0, 12);
  }

  // A home and a symlink to it give one name to a run.
  static async create(
    folder: string,
    workspaces: ContainerWorkspaces,
    options: ContainersOptions = {},
  ) {
    await ensureFolder(folder);
    return new Containers(await realpath(folder), workspaces, options);
  }

  async prepareTree({
    workflowRunId,
    repoPath,
    isMirror,
    definitionSha,
    devcontainer,
  }: ContainerRun): Promise<ContainerTree> {
    if (!devcontainer) {
      throw new Error(
        "The repo has no devcontainer in .halinka/config.yml. Add one, or start the runner with --runs-in worktree.",
      );
    }
    const treeFolder = await this.exportTree(workflowRunId, { repoPath, isMirror }, definitionSha);
    const realTree = (await findRealPath(treeFolder)) ?? treeFolder;
    if (!(await isRealPathInside(resolve(realTree, devcontainer), realTree))) {
      throw new Error(`${devcontainer} is outside the repo`);
    }
    if (!(await isFile(join(treeFolder, devcontainer)))) {
      throw new Error(
        `The commit ${shortSha(definitionSha)} has no ${devcontainer}. Commit it, then start a new run.`,
      );
    }
    return { treeFolder, configPath: devcontainer };
  }

  // A start runs the lifecycle commands again and installs missing agents.
  async start(
    run: ContainerRun,
    { tree, agents = [], proxy = this.options.machineCredentials }: StartOptions,
    signal: AbortSignal,
  ) {
    const { workflowRunId, setupDocker = false } = run;
    const workspaceFolder = this.workspaces.folderOf(workflowRunId);
    if (!(await pathExists(workspaceFolder))) {
      throw new Error(`The workspace ${workspaceFolder} is gone. Remove the workspace of the run.`);
    }
    const gitConfig = await this.workspaces.readGitConfig(workflowRunId);
    const name = this.nameOf(workflowRunId);
    const timeout = AbortSignal.timeout(startTimeoutMs);
    const limit = AbortSignal.any([signal, timeout]);
    try {
      const started = await this.startContainer(
        {
          name,
          workspaceFolder,
          ...tree,
          setupNetwork: run.setupNetwork ?? [],
          isDockerInside: setupDocker,
          gitConfig,
          agents,
          proxy,
        },
        limit,
      );
      await started.sandbox.restoreGitConfig(limit);
      return started;
    } catch (error) {
      // A running container skips the next start, so it must not run without its setup.
      await stopDevcontainer(name).catch(() => {});
      if (!timeout.aborted || signal.aborted) throw error;
      const message = `The container did not start in ${startTimeoutMs / 60_000} minutes`;
      throw new Error(message, { cause: error });
    }
  }

  async startContainer(
    { gitConfig, agents, proxy, ...container }: ContainerSpec,
    signal: AbortSignal,
  ) {
    const { limits, featurePublishers, machineCredentials: _, ...policyOptions } = this.options;
    const policy = new EgressPolicy(container.name, {
      ...policyOptions,
      credentials: () => proxy?.forProxy() ?? {},
    });
    const up = await upDevcontainer({ ...container, policy, limits, featurePublishers }, signal);
    const sandbox = await attachDevcontainer(up, { policy, runnerGitConfig: gitConfig }, signal);
    const args = agents.flatMap(({ command, package: name }) => [command, name]);
    const failed = (reason: string) =>
      new Error(`Halinka could not set up the container: ${reason}`);
    const setUp = await sandbox
      .execAsRoot(["sh", "-c", setUpScript, "setup", ...args], {
        network: [npmRegistry],
        timeoutMs: setUpTimeoutMs,
        signal,
      })
      .catch((error: unknown) => {
        if (signal.aborted) throw error;
        throw failed(errorMessage(error));
      });
    if (setUp.exitCode !== 0) throw failed(setUp.stderr.trim());
    return { sandbox, policy };
  }

  // Until `forgetPolicy`, a credential change reaches the proxy of the run.
  registerPolicy(workflowRunId: number, policy: EgressPolicy) {
    this.policies.set(workflowRunId, policy);
  }

  // Before the release of the workspace lock: the next holder starts the run with its own policy.
  forgetPolicy(workflowRunId: number) {
    this.policies.delete(workflowRunId);
    clearTimeout(this.retries.get(workflowRunId));
    this.retries.delete(workflowRunId);
  }

  // A proxy that fails keeps its earlier credentials until a retry writes them.
  async writePolicies() {
    await Promise.all(
      [...this.policies.keys()].map((workflowRunId) => this.writePolicy(workflowRunId, 0)),
    );
  }

  async apply(target: Located<SandboxTarget>, signal: AbortSignal): Promise<SandboxObservation> {
    const { workflowRunId, repoPath, spec, runBranch } = target;
    const name = this.nameOf(workflowRunId);
    if (spec === "destroyed") {
      await reclaimWorkspace(this.workspaces.folderOf(workflowRunId));
      await deleteDevcontainer(name);
      await this.workspaces.deleteClone(workflowRunId, repoPath, runBranch);
      await rm(this.treeOf(workflowRunId), { recursive: true, force: true });
      return { observed: "absent" };
    }
    const state = await inspectDevcontainer(name);
    if (spec === "stopped") {
      // Also without a main container: a service, the proxy or the networks of the run can stay.
      await stopDevcontainer(name);
      return { observed: state === "absent" ? "absent" : "stopped" };
    }
    if (state === "absent") {
      throw new Error("The container of the run is removed. Reopen a step to make it again.");
    }
    if (state === "stopped")
      await this.start(target, { tree: await this.prepareTree(target) }, signal);
    // Without an attach the portal shows no link; the container still runs.
    const attach = await inspectAttach(name, this.workspaces.folderOf(workflowRunId)).catch(
      () => undefined,
    );
    return { observed: "running", ...(attach && { attach }) };
  }

  private async writePolicy(workflowRunId: number, failures: number) {
    clearTimeout(this.retries.get(workflowRunId));
    this.retries.delete(workflowRunId);
    const policy = this.policies.get(workflowRunId);
    await policy?.write().catch((error: unknown) => {
      if (this.policies.get(workflowRunId) !== policy) return;
      console.error(
        `Halinka could not give the new credentials to the proxy of run ${workflowRunId}: ${errorMessage(error)}`,
      );
      const retry = setTimeout(
        () => void this.writePolicy(workflowRunId, failures + 1),
        backoffMs(failures, writeBackoff),
      );
      // Two writes can fail at the same time.
      clearTimeout(this.retries.get(workflowRunId));
      this.retries.set(workflowRunId, retry);
    });
  }

  async inspectStates(workflowRunIds: number[]) {
    const states = await inspectDevcontainers();
    const absent: DevcontainerStatus = { main: "absent", isActive: false };
    return new Map(workflowRunIds.map((id) => [id, states.get(this.nameOf(id)) ?? absent]));
  }

  // The server names only the run.
  inspectProcesses(workflowRunId: number) {
    return inspectContainerProcesses(
      this.nameOf(workflowRunId),
      this.workspaces.folderOf(workflowRunId),
    );
  }

  nameOf(workflowRunId: number) {
    return `halinka-run-${this.runnerHash}-${workflowRunId}`;
  }

  get testName() {
    return `halinka-agent-test-${this.runnerHash}`;
  }

  private treeOf(workflowRunId: number) {
    return join(this.folder, `${runFolderName(workflowRunId)}.tree`);
  }

  // The build reads this copy, never the clone: the agent can change the clone.
  // A person with push access who is not a Member can write the default branch of a mirror.
  private async exportTree(
    workflowRunId: number,
    { repoPath, isMirror }: { repoPath: string; isMirror: boolean },
    commit: string,
  ) {
    const tree = this.treeOf(workflowRunId);
    if (await pathExists(tree)) return tree;
    await ensureFolder(this.folder);
    const temp = await mkdtemp(`${tree}.`);
    try {
      const archive = join(temp, "tree.tar");
      await hostGit(repoPath, undefined, isMirror ? { env: noHostConfig } : {}).archive(
        commit,
        archive,
      );
      const files = join(temp, "files");
      await ensureFolder(files);
      await run("tar", ["-xf", archive, "-C", files]);
      await rename(files, tree);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    return tree;
  }
}
