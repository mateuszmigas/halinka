import { randomBytes } from "node:crypto";

import {
  type AgentQuestions,
  type ControlPlane,
  type RunnerCapabilities,
  type RunEvent,
  type RunLease,
  type RunnerCommands,
  type SandboxKind,
} from "@halinka/protocol";
import { testBuild } from "@halinka/protocol/testing";
import { hashOf } from "@halinka/utils/hash";
import { eq } from "drizzle-orm";
import { vi } from "vitest";

import { createApp } from "../api/app";
import { createAuth } from "../auth/auth";
import { createApiClient } from "../client";
import { ServerControlPlane } from "../controlPlane";
import type { Db } from "../db/client";
import { createRepositories } from "../db/repositories";
import { repos } from "../db/schema";
import { defaultLeaseTimes } from "../leaseTimes";
import { RunBus } from "../runBus";
import type { RunnerPackage } from "../runnerPackage";
import { SecretCipher } from "../secrets";
import { ServerSettings } from "../serverSettings";
import { createServices } from "../services";
import { hubot, logIn, octo, testAuthConfig } from "./testAuth";
import { registerTestRunner, testKeyOf } from "./testDb";

export const repoPath = "/code/app";
export const linkPath = "/links/app-link";

export const worktreeRunner = {
  sandboxKind: "worktree",
  build: testBuild,
  canUpdate: false,
  agentsOnPath: ["claude-code", "codex"],
} satisfies RunnerCapabilities;

export const testSshHostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5";

export const devcontainerRunner = {
  sandboxKind: "devcontainer",
  build: testBuild,
  canUpdate: false,
  hasDocker: true,
  hasSysbox: false,
  sshHostKey: testSshHostKey,
} satisfies RunnerCapabilities;

// A package that the server only names: the update tests download nothing.
export const testRunnerPackage = { path: "/nowhere/halinka.tgz", sha512: "0", size: 1 };

export const devcontainerConfig =
  "schema_version: 1\nserver: local\ndevcontainer: .devcontainer/devcontainer.json\n";

const runnerOf = (sandboxKind: SandboxKind) =>
  sandboxKind === "devcontainer" ? devcontainerRunner : worktreeRunner;

export const testCipher = new SecretCipher(randomBytes(32));

const testPort = 7070;
export const testApiUrl = `http://127.0.0.1:${testPort}`;

export const secondRepoPath = "/code/web";
export const baseSha = "0123456789abcdef0123456789abcdef01234567";

export const testQuestions: AgentQuestions = [
  {
    question: "Which database?",
    header: "Database",
    options: [
      { label: "Postgres", description: "The current database" },
      { label: "SQLite", description: "A file" },
    ],
    multiSelect: false,
  },
];

export const testCheckpoint = (before: string, after: string, changedFiles = ["a.ts"]) => ({
  before,
  after,
  changedFiles,
});

// Counts the open subscriptions.
export class CountingBus extends RunBus {
  private open = 0;

  override subscribe(...args: Parameters<RunBus["subscribe"]>) {
    this.open++;
    const unsubscribe = super.subscribe(...args);
    return () => {
      this.open--;
      unsubscribe();
    };
  }

  openSubscriptions() {
    return this.open;
  }
}

export const deliveringPrompt = (attemptId: number, messageId: number): RunEvent => {
  const message = { messageId, author: "local", text: "Use SQLite" };
  return {
    kind: "agent_prompt",
    payload: {
      stepId: "implement",
      attemptId,
      text: "Message from local:\nUse SQLite",
      baseText: "",
      messages: [message],
    },
  };
};

export const answeringPrompt = (attemptId: number, itemId: number): RunEvent => ({
  kind: "agent_prompt",
  payload: {
    stepId: "implement",
    attemptId,
    text: "SQLite",
    answered: { itemId, author: "local" },
  },
});

export const agentPrompt = (text: string): RunEvent => ({
  kind: "agent_prompt",
  payload: { stepId: "build", attemptId: 1, text },
});
const buildWorkflow =
  "schema_version: 1\nname: Build\nsteps:\n  - id: build\n    type: shell\n    run: ls\n";

export const implementWorkflow =
  "schema_version: 1\nname: Implement\nsteps:\n  - id: implement\n    type: agent\n    agent: claude-code\n    prompt: Fix the bug\n";

const repoFilesOf = (files: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(files).map(([path, source]) => [path, { source, hash: hashOf(source) }]),
  );

class FakeRunnerCommands implements RunnerCommands {
  readonly files: Record<string, string> = {
    ".halinka/config.yml": "schema_version: 1\nserver: local\n",
    ".halinka/workflows/build.yml": buildWorkflow,
  };
  readonly baseCommitFiles: Record<string, string> = {};
  readonly wake = vi.fn(async () => {});
  readonly readRepo = vi.fn<RunnerCommands["readRepo"]>(async ({ repoPath: path }) => {
    const realPath = path === linkPath ? repoPath : path;
    const read = realPath === repoPath || realPath === secondRepoPath ? this.files : {};
    return { realPath, head: baseSha, files: repoFilesOf(read) };
  });
  readonly writeRepoFile = vi.fn<RunnerCommands["writeRepoFile"]>(async ({ path, source }) => {
    this.files[path] = source;
    return { hash: hashOf(source) };
  });
  readonly readCommitFile = vi.fn<RunnerCommands["readCommitFile"]>(async ({ path }) => {
    const source = this.baseCommitFiles[path];
    return source === undefined ? undefined : { source };
  });
  readonly listFolders = vi.fn<RunnerCommands["listFolders"]>(async ({ path }) => ({
    path: path ?? "/home/test",
    parent: "/",
    isRepo: false,
    folders: [{ name: "app", path: `${path ?? "/home/test"}/app`, isRepo: true }],
    isTruncated: false,
  }));
  readonly listDevcontainers = vi.fn<RunnerCommands["listDevcontainers"]>(async () => []);
  readonly setUpRepo = vi.fn<RunnerCommands["setUpRepo"]>(async ({ server, devcontainer }) => {
    this.files[".halinka/config.yml"] = devcontainer
      ? `schema_version: 1\nserver: ${server}\ndevcontainer: ${devcontainer}\n`
      : `schema_version: 1\nserver: ${server}\n`;
    return { files: [".halinka/config.yml"] };
  });
  readonly pushBranch = vi.fn<RunnerCommands["pushBranch"]>(async () => {});
  readonly openPullRequest = vi.fn<RunnerCommands["openPullRequest"]>(async () => ({
    url: "https://github.com/acme/app/pull/1",
    isCreated: true,
  }));
  readonly openRelay = vi.fn<RunnerCommands["openRelay"]>(async () => {});
}

// The changes of the run that the bus signals from now on.
export const recordChanges = (bus: RunBus, workflowRunId: number) => {
  const changes: string[] = [];
  bus.subscribe(workflowRunId, (change) => changes.push(change));
  return changes;
};

export const createTestServer = async (
  db: Db,
  options: {
    bus?: RunBus;
    portalFolder?: string;
    isRemoteRunner?: boolean;
    hasAuth?: boolean;
    runnerPackage?: RunnerPackage;
  } = {},
) => {
  const commands = new FakeRunnerCommands();
  const { files, baseCommitFiles } = commands;
  const bus = options.bus ?? new RunBus();
  const runnerId = (await registerTestRunner(db, "local")).id;
  const closed = vi.fn<(runnerId: number, reason: string) => void>();
  let isConnected = true;
  const disconnect = () => {
    isConnected = false;
  };
  const connectedRunners = {
    commandsOf: (id: number) => (id === runnerId && isConnected ? [commands] : []),
    listIds: () => (isConnected ? [runnerId] : []),
    close: closed,
  };
  const localRunnerId = options.isRemoteRunner ? undefined : runnerId;
  const services = createServices({
    db,
    build: testBuild,
    serverSettings: await ServerSettings.load(createRepositories(db)),
    publicUrl: testApiUrl,
    ...(options.runnerPackage && { runnerPackage: options.runnerPackage }),
    connectedRunners,
    bus,
    localRunnerId: () => localRunnerId,
    cipher: testCipher,
  });
  const app = createApp(services, {
    port: () => testPort,
    portalFolder: options.portalFolder,
    ...(options.runnerPackage && { runnerPackage: options.runnerPackage }),
    auth: options.hasAuth ? createAuth(db, services.member, testAuthConfig(testApiUrl)) : undefined,
  });
  let apiCookie = "";
  const api = createApiClient(testApiUrl, {
    fetch: async (request) => {
      request.headers.set("cookie", apiCookie);
      return app.fetch(request);
    },
  });
  const planeOf = (instanceId: string) =>
    new ServerControlPlane(
      { runnerId, instanceId, publicKey: testKeyOf("local") },
      {
        db,
        serverBuild: { buildId: testBuild.id, hasPackage: options.runnerPackage !== undefined },
        bus,
        leaseSeconds: defaultLeaseTimes.leaseSeconds,
        cipher: testCipher,
        gitHubApp: services.gitHubApp,
      },
    );
  const plane = planeOf("test");
  return {
    files,
    baseCommitFiles,
    commands,
    closed,
    disconnect,
    bus,
    runnerId,
    plane,
    planeOf,
    app,
    api,
    services,
    setApiCookie: (cookie: string) => {
      apiCookie = cookie;
    },
  };
};

export const createConnectedTestServer = async (
  db: Db,
  options: {
    bus?: RunBus;
    isRemoteRunner?: boolean;
    hasAuth?: boolean;
    runnerPackage?: RunnerPackage;
  } = {},
) => {
  const server = await createTestServer(db, options);
  const { plane, api, files, runnerId } = server;
  if (options.hasAuth) {
    await createRepositories(db).repo.register({ name: "app", path: repoPath, runnerId });
  } else {
    await api.repos.register({ runnerId, path: repoPath });
  }
  // A devcontainer runner takes only a run of a repo with a devcontainer.
  const queue = async (sandboxKind: SandboxKind = "worktree") => {
    if (sandboxKind === "devcontainer") files[".halinka/config.yml"] = devcontainerConfig;
    return (await api.runs.create({ repoId: 1, workflow: "build" })).id;
  };
  const claimOne = async (held: RunLease[] = [], sandboxKind: SandboxKind = "worktree") => {
    const [claimed] = (await plane.sync({ held, capacity: 1, capabilities: runnerOf(sandboxKind) }))
      .claimed;
    if (!claimed) throw new Error("No run was claimed");
    return claimed;
  };
  const finishOne = async (sandboxKind: SandboxKind = "worktree") => {
    await queue(sandboxKind);
    const claimed = await claimOne([], sandboxKind);
    await plane.finishRun(claimed.lease, "succeeded");
    return claimed;
  };
  const waitForApproval = async (held: RunLease[] = [], sandboxKind: SandboxKind = "worktree") => {
    await queue(sandboxKind);
    const claimed = await claimOne(held, sandboxKind);
    const stepRunId = await plane.startStep(claimed.lease, "approve");
    await plane.startAttempt(claimed.lease, stepRunId);
    const itemId = await plane.openApproval(claimed.lease, stepRunId, "Check the diff");
    return { claimed, stepRunId, itemId };
  };
  const waitForGate = async () => {
    await queue();
    const claimed = await claimOne();
    const stepRunId = await plane.startStep(claimed.lease, "implement");
    const { attemptId } = await plane.startAttempt(claimed.lease, stepRunId);
    const failed = { status: "failed", summary: "Done", outcome: "done" } as const;
    const itemId = await plane.askHuman(claimed.lease, attemptId, {
      result: failed,
      kind: "ask_human",
      message: "These gates failed.",
    });
    return { claimed, stepRunId, attemptId, itemId };
  };
  const waitForQuestion = async () => {
    await queue();
    const claimed = await claimOne();
    const stepRunId = await plane.startStep(claimed.lease, "implement");
    const { attemptId } = await plane.startAttempt(claimed.lease, stepRunId);
    const itemId = await plane.askQuestion(claimed.lease, attemptId, testQuestions);
    return { claimed, stepRunId, attemptId, itemId };
  };
  const startAgentStep = async () => {
    files[".halinka/workflows/implement.yml"] = implementWorkflow;
    await api.runs.create({ repoId: 1, workflow: "implement" });
    const claimed = await claimOne();
    const stepRunId = await plane.startStep(claimed.lease, "implement");
    const { attemptId } = await plane.startAttempt(claimed.lease, stepRunId);
    return { claimed, stepRunId, attemptId };
  };
  return {
    ...server,
    queue,
    claimOne,
    finishOne,
    waitForApproval,
    waitForGate,
    waitForQuestion,
    startAgentStep,
  };
};

export const createLoginTestServer = async (db: Db) => {
  const server = await createConnectedTestServer(db, { hasAuth: true });
  const apiOf = (cookie: string) =>
    createApiClient(testApiUrl, {
      fetch: async (request) => {
        request.headers.set("cookie", cookie);
        return server.app.fetch(request);
      },
    });
  const adminApi = async () => apiOf((await logIn(server.app, testApiUrl, octo)).cookie);
  const memberCookie = async () => {
    await (await adminApi()).members.create({ login: "hubot", role: "member" });
    return (await logIn(server.app, testApiUrl, hubot)).cookie;
  };
  const memberApi = async () => apiOf(await memberCookie());
  return { ...server, adminApi, memberApi, memberCookie };
};

type SyncRunnerOptions = { canTest?: boolean };

export const syncRunner = (
  plane: ControlPlane,
  capabilities: RunnerCapabilities,
  { canTest = true }: SyncRunnerOptions = {},
) => plane.sync({ held: [], capacity: 0, capabilities, canTest });

export const requestedAgentTest = async (db: Db) => {
  const server = await createConnectedTestServer(db);
  await server.api.agents.test({ preset: "claude-code", runner: "local" });
  const readTest = async () =>
    (await server.api.agents.list())
      .find(({ preset }) => preset === "claude-code")
      ?.tests.find(({ runner }) => runner === "local");
  return { ...server, readTest };
};

export const runningAgentTest = async (
  db: Db,
  capabilities: RunnerCapabilities = devcontainerRunner,
) => {
  const server = await requestedAgentTest(db);
  const { agentTest } = await syncRunner(server.plane, capabilities);
  if (!agentTest) throw new Error("No test was claimed");
  return { ...server, token: agentTest.token };
};

export const gpuWorkflow =
  "schema_version: 1\nname: Gpu\nruns-on: [gpu]\nsteps:\n  - { id: build, type: shell, run: ls }\n";

export const publishSteps = [
  "  - { id: build, type: shell, run: ls }",
  "  - { id: publish, type: github, action: open_pull_request }",
];

export const publishWorkflow = [
  "schema_version: 1",
  "name: Publish",
  "steps:",
  ...publishSteps,
  "",
].join("\n");

// A `github` row from a registered repo.
export const makeGitHubRepo = (db: Db, id: number, githubRepoId: number) =>
  db
    .update(repos)
    .set({ kind: "github", name: "acme/app", path: null, runnerId: null, githubRepoId })
    .where(eq(repos.id, id));
