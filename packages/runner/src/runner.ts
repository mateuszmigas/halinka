import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  type Build,
  type ProtocolError,
  type RepoPlace,
  type RunnerCommands,
  type RunnerConnection,
  type RunnerTransport,
  type SandboxKind,
  updateNeeded,
} from "@halinka/protocol";
import { type ContainerLimits, createProxyTls, sysboxRuntime } from "@halinka/sandbox/devcontainer";
import { FileLocks, type Release } from "@halinka/utils/fileLocks";

import { AgentTests } from "./agentTests";
import { BranchPusher } from "./branchPusher";
import { inspectCapabilities } from "./capabilities";
import { CodexLogins } from "./codexLogins";
import { ContainerRuns } from "./containerRuns";
import { Containers } from "./containers";
import { Credentials } from "./credentials";
import { FolderRoots } from "./folderRoots";
import { ghLogin } from "./github";
import { GitHubMirrors } from "./githubMirrors";
import { listFolders, listFoldersIn } from "./listFolders";
import { loadOrCreateSshHostKey } from "./loadOrCreateSshHostKey";
import { maskingCommands } from "./maskingCommands";
import { readCommitFile } from "./readCommitFile";
import { readRepo } from "./readRepo";
import { RepoFileWriter } from "./repoFileWriter";
import { listDevcontainers, setUpRepo } from "./repoSetup";
import { RunExecutor } from "./runExecutor";
import { takeRunnerLock } from "./runnerLock";
import { runnerPlane } from "./runnerPlane";
import { RunRelays } from "./runRelays";
import { Sandboxes } from "./sandboxes";
import { Supervisor } from "./supervisor";
import { Workspaces, runFolderName } from "./workspaces";
import { WorktreeRuns } from "./worktreeRuns";

const pollMs = 5000;
const sandboxSweepMs = 5 * 60 * 1000;
const maxSandboxApplies = 2;

type RunnerOptions = {
  home: string;
  build: Build;
  canUpdate?: boolean;
  sandboxKind: SandboxKind;
  capacity: number;
  reachable?: string[];
  limits?: ContainerLimits;
  featurePublishers?: string[];
  isDockerInContainer?: boolean;
  // Without it, the server reaches every folder of the runner user: for `halinka start`.
  folderRoots?: string[];
  onFailedAttempt?: (error: Error) => void;
};

type Connected = {
  connection: RunnerConnection;
  supervisor: Supervisor;
  sandboxes: Sandboxes;
  containers: Containers;
  pusher: BranchPusher;
  codexLogins: CodexLogins;
  relays: RunRelays;
  agentTests: AgentTests;
};

export class Runner {
  private readonly instanceId = randomUUID();
  private readonly writer = new RepoFileWriter();
  private readonly stopping = new AbortController();
  private readonly ended = Promise.withResolvers<ProtocolError | undefined>();
  private connected: Connected | undefined;
  private starting: Promise<void> | undefined;
  private stopped: Promise<void> | undefined;
  private releaseRunnerLock: Release | undefined;
  private isLockedByCaller = false;
  private refusal: ProtocolError | undefined;
  private isUpdateRequested = false;
  private isRefusingUpdates = false;
  // After the runner stopped: the refusal of a final close, or `undefined`.
  readonly closed = this.ended.promise;

  get serverId() {
    return this.connected?.connection.serverId;
  }

  constructor(
    private readonly transport: RunnerTransport,
    private readonly options: RunnerOptions,
  ) {}

  // The caller releases this lock, also after a stop: an update installs a build before the exit.
  async lock() {
    const release = await takeRunnerLock(this.options.home, this.instanceId);
    this.isLockedByCaller = true;
    return release;
  }

  // After a failed update: the server then asks this process for no update, which would fail again.
  refuseUpdates() {
    this.isRefusingUpdates = true;
  }

  start() {
    this.starting = this.connect().catch(async (error: unknown) => {
      await this.releaseOwnLock();
      throw error;
    });
    return this.starting;
  }

  stop() {
    this.stopped ??= this.disconnect();
    return this.stopped;
  }

  private async disconnect() {
    this.stopping.abort();
    // A stop during start must also stop the supervisor that the start creates.
    await this.starting?.catch(() => {});
    const { connected } = this;
    this.connected = undefined;
    // `closed` must resolve after a failed stop too: the exit code of a service depends on it.
    try {
      connected?.relays.stopAll();
      const loginsStopped = connected?.codexLogins.stop();
      const testsStopped = connected?.agentTests.stop();
      const sandboxesStopped = connected?.sandboxes.stop();
      await connected?.supervisor.stop({ isGivingBack: this.refusal === undefined });
      await sandboxesStopped;
      await loginsStopped;
      await testsStopped;
      connected?.connection.close();
    } finally {
      await this.releaseOwnLock();
      this.ended.resolve(
        this.refusal ??
          (this.isUpdateRequested
            ? updateNeeded("The server asked this runner to restart with its build")
            : undefined),
      );
    }
  }

  private async connect() {
    const { home, build, sandboxKind, capacity, reachable, limits, featurePublishers } =
      this.options;
    const { isDockerInContainer = false, folderRoots } = this.options;
    if (!this.isLockedByCaller) {
      this.releaseRunnerLock ??= await takeRunnerLock(home, this.instanceId);
    }
    // Each start of a run's proxy publishes this key again.
    const proxyTls = createProxyTls();
    const credentials = new Credentials(process.env, { proxyCa: proxyTls.cert });
    const { lent } = credentials;
    const codexLogins = new CodexLogins({
      home,
      credentials,
      writePolicies: async () => this.connected?.containers.writePolicies(),
    });
    const sshHostKey = await loadOrCreateSshHostKey(home);
    const inspect = () =>
      inspectCapabilities(sandboxKind, {
        build,
        canUpdate: (this.options.canUpdate ?? false) && !this.isRefusingUpdates,
        sshHostKey: sshHostKey.publicKey,
        isDockerInContainer,
      });
    const [capabilities] = await Promise.all([inspect(), codexLogins.read()]);
    if (
      isDockerInContainer &&
      capabilities.sandboxKind === "devcontainer" &&
      capabilities.hasDocker &&
      !capabilities.hasSysbox
    ) {
      console.warn(
        `Docker has no ${sysboxRuntime} runtime. Runs whose repo asks for Docker in the container wait. Install Sysbox, then start the runner again.`,
      );
    }
    const roots = folderRoots && new FolderRoots(folderRoots, home);
    // The runner makes the path of a mirror, so only a checkout needs the roots.
    const requirePlaceInRoots = async ({ repoPath }: RepoPlace) => {
      if (repoPath !== undefined) await roots?.requireRepoInRoots(repoPath);
    };
    const inRoots =
      <I extends RepoPlace, O>(command: (input: I) => Promise<O>) =>
      async (input: I) => {
        await requirePlaceInRoots(input);
        return command(input);
      };
    const ready = () => {
      if (!this.connected) throw new Error("The runner is not ready");
      return this.connected;
    };
    const commands: RunnerCommands = {
      wake: async () => this.connected?.supervisor.wake(),
      readRepo: inRoots(readRepo),
      readCommitFile: inRoots(readCommitFile),
      writeRepoFile: inRoots((input) => this.writer.write(input)),
      listFolders: roots ? listFoldersIn(roots) : listFolders,
      listDevcontainers: inRoots(listDevcontainers),
      setUpRepo: inRoots(setUpRepo),
      pushBranch: inRoots((input) => ready().pusher.push(input)),
      openPullRequest: inRoots((input) => ready().pusher.openPullRequest(input)),
      openRelay: async ({ relayId, workflowRunId }) => {
        if (sandboxKind !== "devcontainer") throw new Error("This runner runs no containers");
        const connected = ready();
        const processes = await connected.containers.inspectProcesses(workflowRunId);
        const stream = await connected.connection.openRelay(relayId);
        connected.relays.serve(workflowRunId, processes, stream);
      },
    };
    const connection = await this.transport.connect(
      { instanceId: this.instanceId },
      maskingCommands(commands, lent),
      {
        signal: this.stopping.signal,
        onFailedAttempt: this.options.onFailedAttempt,
      },
    );
    // Each server numbers its runs and repos from 1, so each has its own folders.
    const workspacesFolder = join(home, "workspaces", connection.serverId);
    const workspaces = new Workspaces(workspacesFolder);
    const mirrors = new GitHubMirrors(join(home, "github", connection.serverId));
    const containers = await Containers.create(workspacesFolder, workspaces, {
      machineCredentials: credentials,
      certificate: proxyTls,
      reachable,
      limits,
      featurePublishers,
    });
    const locks = new FileLocks(workspacesFolder, this.instanceId);
    const pusher = new BranchPusher({ locks, workspaces, mirrors, lent, auth: ghLogin });
    const planeOf = (signal: AbortSignal) => runnerPlane(connection.plane, lent, signal);
    const plane = planeOf(this.stopping.signal);
    const sandboxes = new Sandboxes({
      plane,
      host: {
        apply: async (target, signal) => {
          await requirePlaceInRoots(target);
          const located = {
            ...target,
            repoPath: target.repoPath ?? mirrors.pathOf(target.githubRepoId),
            isMirror: target.repoPath === undefined,
          };
          return target.kind === "devcontainer"
            ? containers.apply(located, signal)
            : { observed: await workspaces.apply(located) };
        },
        inspectContainers: (workflowRunIds) => containers.inspectStates(workflowRunIds),
      },
      locks: { tryTake: (workflowRunId) => locks.tryTake(runFolderName(workflowRunId)) },
      maxApplying: maxSandboxApplies,
      sweepMs: sandboxSweepMs,
    });
    // One test at a time per runner.
    const testFolder = join(workspacesFolder, "agent-test");
    const runs =
      sandboxKind === "devcontainer"
        ? new ContainerRuns({
            containers,
            workspaces,
            credentials,
            codexLogins,
            lent,
            planeOf,
            testFolder,
          })
        : new WorktreeRuns(workspaces, testFolder);
    const executor = new RunExecutor({
      sandboxKind,
      runs,
      planeOf,
      lent,
      locks,
      workspaces,
      mirrors,
      pusher,
      requirePlaceInRoots,
    });
    const agentTests = new AgentTests({
      plane,
      lent,
      run: (test, signal) => runs.test(test, signal),
      cleanUp: () => runs.deleteTest(),
    });
    const relays = new RunRelays(sshHostKey.privateKey, (workflowRunId) =>
      supervisor.isHolding(workflowRunId),
    );
    const supervisor = new Supervisor({
      plane,
      capacity,
      capabilities,
      inspectCapabilities: inspect,
      pollMs,
      lent,
      sandboxes,
      agentTests,
      onClaim: (workflowRunId) => relays.stopRun(workflowRunId),
      onUpdate: () => {
        this.isUpdateRequested = true;
        this.stopInBackground();
      },
      execute: (run, inbox, signal) => executor.execute(run, inbox, signal),
    });
    supervisor.start();
    codexLogins.start();
    this.connected = {
      connection,
      supervisor,
      sandboxes,
      containers,
      pusher,
      codexLogins,
      relays,
      agentTests,
    };
    void connection.closed.then((refusal) => {
      if (refusal === undefined) return;
      this.refusal = refusal;
      this.stopInBackground();
    });
  }

  private stopInBackground() {
    this.stop().catch((error: unknown) => console.error("The runner did not stop cleanly", error));
  }

  private async releaseOwnLock() {
    await this.releaseRunnerLock?.();
    this.releaseRunnerLock = undefined;
  }
}
