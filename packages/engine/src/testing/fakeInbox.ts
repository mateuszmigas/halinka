import type { AgentAnswer, AgentMessage, InboxItemDecision } from "@halinka/protocol";
import { abortError } from "@halinka/utils/errors";

import type { InboxDecision, RunInbox } from "../runDeps";

const untilAborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(abortError())));

export class FakeInbox implements RunInbox {
  private readonly decisions = new Map<number, InboxDecision>();
  private readonly waits = Promise.withResolvers<void>();
  private readonly pending = new Map<number, AgentMessage[]>();
  private readonly arrivals = new Map<number, PromiseWithResolvers<void>>();
  private nextMessageId = 30;

  get waiting() {
    return this.waits.promise;
  }

  decide(itemId: number, decision: InboxItemDecision, note?: string) {
    this.decisions.set(itemId, { decision, note, resolvedBy: "local" });
  }

  answer(itemId: number, answer: AgentAnswer) {
    this.decisions.set(itemId, { decision: "answered", answer, resolvedBy: "local" });
  }

  // The first step run of a run has the id 10.
  sendMessage(text: string, author = "local", stepRunId = 10) {
    const message = { workflowRunId: 1, messageId: this.nextMessageId++, stepRunId, text, author };
    this.pending.set(stepRunId, [...(this.pending.get(stepRunId) ?? []), message]);
    this.arrival(stepRunId).resolve();
  }

  async waitForDecision(itemId: number, signal: AbortSignal) {
    const decision = this.decisions.get(itemId);
    if (decision) return decision;
    this.waits.resolve();
    return untilAborted(signal);
  }

  takeMessages(stepRunId: number) {
    const taken = this.pending.get(stepRunId) ?? [];
    this.pending.delete(stepRunId);
    this.arrivals.delete(stepRunId);
    return taken;
  }

  messageArrived(stepRunId: number, signal: AbortSignal) {
    return Promise.race([this.arrival(stepRunId).promise, untilAborted(signal)]);
  }

  private arrival(stepRunId: number) {
    const found = this.arrivals.get(stepRunId) ?? Promise.withResolvers<void>();
    this.arrivals.set(stepRunId, found);
    return found;
  }
}
