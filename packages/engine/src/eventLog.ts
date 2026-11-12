import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import {
  type ControlPlane,
  type EventBatch,
  hasCode,
  isTransient,
  maxBatchBytes,
  maxEventBytes,
  mergeRunEvents,
  type RunEvent,
  type RunLease,
} from "@halinka/protocol";
import { errorMessage } from "@halinka/utils/errors";
import { backoffMs } from "@halinka/utils/retry";

const flushMs = 200;
const maxBatchEvents = 200;
const sendBackoff = { initialDelayMs: 100, maxDelayMs: 2000 };

export class EventLog {
  private readonly abandoned = new AbortController();
  private readonly stopController = new AbortController();
  private pending: RunEvent[] = [];
  private pendingBytes = 0;
  private timer: NodeJS.Timeout | undefined;
  private sent = Promise.resolve();

  constructor(
    private readonly plane: Pick<ControlPlane, "appendEvents">,
    private readonly lease: RunLease,
  ) {}

  // Aborts with the error when the server refuses events for good: a lost lease or a refusal.
  get stopped(): AbortSignal {
    return this.stopController.signal;
  }

  emit(event: RunEvent) {
    if (this.abandoned.signal.aborted) return;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > maxEventBytes) {
      console.error(
        `Run ${this.lease.workflowRunId}: a ${event.kind} event of ${bytes} bytes is too large to store`,
      );
      return;
    }
    this.pendingBytes += bytes;
    const last = this.pending.at(-1);
    const merged = last && mergeRunEvents(last, event);
    if (merged) this.pending[this.pending.length - 1] = merged;
    else this.pending.push(event);
    if (this.pending.length >= maxBatchEvents || this.pendingBytes >= maxBatchBytes) {
      this.flushLater();
    } else this.timer ??= setTimeout(() => this.flushLater(), flushMs);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.length > 0) {
      const batch = { batchId: randomUUID(), events: this.pending };
      this.pending = [];
      this.pendingBytes = 0;
      this.sent = this.sent.then(() => this.send(batch));
    }
    return this.sent;
  }

  async flushBefore(signal: AbortSignal) {
    const aborted = Promise.withResolvers<boolean>();
    const onAbort = () => aborted.resolve(false);
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([this.flush().then(() => true), aborted.promise]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  abandon() {
    clearTimeout(this.timer);
    this.abandoned.abort();
  }

  private flushLater() {
    this.flush().catch(() => {});
  }

  private async send(batch: EventBatch) {
    for (let failures = 0; ; failures++) {
      try {
        return await this.plane.appendEvents(this.lease, batch);
      } catch (error) {
        if (this.stopped.aborted || this.abandoned.signal.aborted) throw error;
        if (hasCode(error, "lease_lost")) {
          this.stopController.abort(error);
          throw error;
        }
        if (!isTransient(error)) {
          const refusal = new Error(
            `The server refused the events of the run: ${errorMessage(error)}`,
            { cause: error },
          );
          this.stopController.abort(refusal);
          throw refusal;
        }
        console.error(`Run ${this.lease.workflowRunId}: the server did not store events`, error);
        await sleep(backoffMs(failures, sendBackoff), undefined, {
          signal: this.abandoned.signal,
        });
      }
    }
  }
}
