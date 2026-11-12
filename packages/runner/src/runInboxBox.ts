import type { InboxDecision, RunInbox } from "@halinka/engine";
import type { AgentMessage, InboxAnswer } from "@halinka/protocol";

const untilAborted = async <T>(promise: Promise<T>, signal: AbortSignal) => {
  signal.throwIfAborted();
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([promise, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

const ensureSlot = <T>(slots: Map<number, PromiseWithResolvers<T>>, key: number) => {
  const found = slots.get(key);
  if (found) return found;
  const created = Promise.withResolvers<T>();
  slots.set(key, created);
  return created;
};

export class RunInboxBox implements RunInbox {
  private readonly decisions = new Map<number, PromiseWithResolvers<InboxDecision>>();
  // `sync` can give the same decision or message again.
  private readonly delivered = new Set<number>();
  private readonly messages = new Map<number, AgentMessage[]>();
  private readonly arrivals = new Map<number, PromiseWithResolvers<void>>();
  // The engine waits for a person only through `waitForDecision`.
  private waits = 0;

  constructor(private readonly onWait: () => void = () => {}) {}

  isWaiting() {
    return this.waits > 0;
  }

  deliverAnswer({ itemId, decision, note, answer, resolvedBy }: InboxAnswer) {
    ensureSlot(this.decisions, itemId).resolve({ decision, note, answer, resolvedBy });
  }

  deliverMessage(message: AgentMessage) {
    const { messageId, stepRunId } = message;
    if (this.delivered.has(messageId)) return;
    this.delivered.add(messageId);
    this.messages.set(stepRunId, [...(this.messages.get(stepRunId) ?? []), message]);
    ensureSlot(this.arrivals, stepRunId).resolve();
  }

  async waitForDecision(itemId: number, signal: AbortSignal) {
    this.waits++;
    this.onWait();
    try {
      return await untilAborted(ensureSlot(this.decisions, itemId).promise, signal);
    } finally {
      this.waits--;
    }
  }

  takeMessages(stepRunId: number) {
    const taken = this.messages.get(stepRunId) ?? [];
    this.messages.delete(stepRunId);
    this.arrivals.delete(stepRunId);
    return taken;
  }

  messageArrived(stepRunId: number, signal: AbortSignal) {
    return untilAborted(ensureSlot(this.arrivals, stepRunId).promise, signal);
  }
}
