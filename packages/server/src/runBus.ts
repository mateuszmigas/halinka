import type { Db } from "./db/client";
import { inTransaction, type Repositories } from "./db/repositories";

export type RunChange = "events" | "state";

type Listener = (change: RunChange) => void;

// Signal only, one server process: a stream reads the new rows itself.
export class RunBus {
  private readonly listeners = new Map<number, Set<Listener>>();
  private readonly notifications = new Set<Promise<void>>();

  subscribe(workflowRunId: number, listener: Listener) {
    const listeners = this.listeners.get(workflowRunId) ?? new Set();
    this.listeners.set(workflowRunId, listeners.add(listener));
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(workflowRunId);
    };
  }

  notify(workflowRunId: number, change: RunChange) {
    for (const listener of this.listeners.get(workflowRunId) ?? []) listener(change);
  }

  // No `runnerId`: a change of the agent settings. A failure here must not fail the change.
  notifyQueuedRuns({ workflowRun }: Pick<Repositories, "workflowRun">, runnerId?: number) {
    const queued =
      runnerId === undefined
        ? workflowRun.listQueuedIds()
        : workflowRun.listQueuedIdsByRunner(runnerId);
    const notification: Promise<void> = queued
      .then((runs) => {
        for (const { id } of runs) this.notify(id, "state");
      })
      .catch((error: unknown) => console.error(error))
      .finally(() => this.notifications.delete(notification));
    this.notifications.add(notification);
    return notification;
  }

  // The server closes the database after this.
  async idle() {
    await Promise.all(this.notifications);
  }
}

// Sends the signals of the changes that `use` reports after the commit.
export const inRunTransaction = async <T>(
  db: Db,
  bus: RunBus,
  use: (
    repositories: Repositories,
    changed: (workflowRunId: number, change: RunChange) => void,
  ) => Promise<T>,
) => {
  const changes: [number, RunChange][] = [];
  const result = await inTransaction(db, (repositories) =>
    use(repositories, (workflowRunId, change) => changes.push([workflowRunId, change])),
  );
  for (const [workflowRunId, change] of changes) bus.notify(workflowRunId, change);
  return result;
};
