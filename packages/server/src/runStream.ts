import type { StoredRunEvent, WorkflowRunEventRepository } from "./db/repositories";
import type { RunBus, RunChange } from "./runBus";

type RunStreamOptions = { workflowRunId: number; afterSeq: number };

type RunStreamMessage = { type: "events"; events: StoredRunEvent[] } | { type: "state" };

export class RunStream {
  // `state` first, so a client that reconnects reads the run again
  private readonly pending = new Set<RunChange>(["state", "events"]);
  private readonly unsubscribe: () => void;
  private isStopped = false;
  private wake = () => {};

  private readonly workflowRunId: number;
  private afterSeq: number;

  constructor(
    private readonly events: WorkflowRunEventRepository,
    bus: RunBus,
    { workflowRunId, afterSeq }: RunStreamOptions,
  ) {
    this.workflowRunId = workflowRunId;
    this.afterSeq = afterSeq;
    this.unsubscribe = bus.subscribe(workflowRunId, (change) => {
      this.pending.add(change);
      this.wake();
    });
  }

  async next(): Promise<IteratorResult<RunStreamMessage, undefined>> {
    while (!this.isStopped) {
      if (this.pending.delete("state")) return { done: false, value: { type: "state" } };
      if (this.pending.delete("events")) {
        const events = await this.events.listByRun(this.workflowRunId, this.afterSeq);
        const last = events.at(-1);
        if (!last) continue;
        this.afterSeq = last.seq;
        return { done: false, value: { type: "events", events } };
      }
      const woken = Promise.withResolvers<void>();
      this.wake = woken.resolve;
      await woken.promise;
    }
    return { done: true, value: undefined };
  }

  stop() {
    if (this.isStopped) return;
    this.isStopped = true;
    this.unsubscribe();
    this.wake();
  }
}
