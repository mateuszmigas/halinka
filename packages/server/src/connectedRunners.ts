import { hasCode, type RunnerCommands } from "@halinka/protocol";
import { errorMessage } from "@halinka/utils/errors";

import type { Repositories } from "./db/repositories";
import { noRunner, ServiceError } from "./services/serviceError";

export type ConnectedRunners = {
  // the newest last
  commandsOf: (runnerId: number) => RunnerCommands[];
  listIds: () => number[];
  // the runner gets `reason` and does not connect again
  close: (runnerId: number, reason: string) => void;
};

export const isConnected = (connectedRunners: ConnectedRunners, runnerId: number) =>
  connectedRunners.commandsOf(runnerId).length > 0;

const runnerOffline = () => new ServiceError("RUNNER_OFFLINE", "The runner is not connected");

const toServiceError = (error: unknown) => {
  if (hasCode(error, "invalid_input")) {
    return new ServiceError("BAD_REQUEST", errorMessage(error));
  }
  if (hasCode(error, "invalid_definitions")) {
    return new ServiceError("INVALID_DEFINITIONS", errorMessage(error));
  }
  if (hasCode(error, "conflict")) return new ServiceError("CONFLICT", errorMessage(error));
  if (hasCode(error, "connection_closed")) return runnerOffline();
  if (hasCode(error, "timeout")) {
    return new ServiceError(
      "CONFLICT",
      `${errorMessage(error)}. The command can still take effect: check its result before you try again.`,
    );
  }
  return error;
};

const mapped = <T>(result: Promise<T>) =>
  result.catch((error: unknown) => {
    throw toServiceError(error);
  });

export const requireRunner = (connectedRunners: ConnectedRunners, runnerId: number) => {
  const commands = connectedRunners.commandsOf(runnerId).at(-1);
  if (!commands) throw runnerOffline();
  return {
    readRepo: (input) => mapped(commands.readRepo(input)),
    writeRepoFile: (input) => mapped(commands.writeRepoFile(input)),
    readCommitFile: (input) => mapped(commands.readCommitFile(input)),
    listFolders: (input) => mapped(commands.listFolders(input)),
    listDevcontainers: (input) => mapped(commands.listDevcontainers(input)),
    setUpRepo: (input) => mapped(commands.setUpRepo(input)),
    pushBranch: (input) => mapped(commands.pushBranch(input)),
    openPullRequest: (input) => mapped(commands.openPullRequest(input)),
  } satisfies Partial<RunnerCommands>;
};

export const requireKnownRunner = async (
  { runner }: Repositories,
  connectedRunners: ConnectedRunners,
  runnerId: number,
) => {
  if (!(await runner.findById(runnerId))) throw noRunner(runnerId);
  return requireRunner(connectedRunners, runnerId);
};

// Only a hint: a process that misses it syncs at its next poll.
export const wakeProcesses = (connectedRunners: ConnectedRunners, runnerId: number) => {
  for (const commands of connectedRunners.commandsOf(runnerId)) commands.wake().catch(() => {});
};

export type WakeRunner = (workflowRunId: number) => Promise<void>;

export const createWakeRunner =
  ({ workflowRun }: Repositories, connectedRunners: ConnectedRunners): WakeRunner =>
  async (workflowRunId) => {
    const runnerId = await workflowRun.findRunnerId(workflowRunId);
    const runnerIds = runnerId === undefined ? connectedRunners.listIds() : [runnerId];
    for (const id of runnerIds) wakeProcesses(connectedRunners, id);
  };
