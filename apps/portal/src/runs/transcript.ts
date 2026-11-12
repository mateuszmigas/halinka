import { mergeRunEvents, type RunEvent, type StoredRunEvent } from "@halinka/server/client";

import { type AgentUpdate, isSystemEvent, toolCallIdOf } from "./agentUpdate";

export type TranscriptItem = { seq: number; event: RunEvent };

type AgentUpdateEvent = Extract<RunEvent, { kind: "agent_update" }>;

type AgentPromptEvent = Extract<RunEvent, { kind: "agent_prompt" }>;

const definedFields = (update: AgentUpdate) =>
  Object.fromEntries(Object.entries(update).filter(([, value]) => value != null));

const withUpdate = (event: AgentUpdateEvent, update: AgentUpdate): AgentUpdateEvent => ({
  ...event,
  payload: { ...event.payload, update },
});

// A limit before a turn sends its messages again.
const chatPrompt = (event: AgentPromptEvent, shown: Set<number>): AgentPromptEvent => {
  const { baseText, messages } = event.payload;
  if (!messages) return event;
  const unshown = messages.filter(({ messageId }) => !shown.has(messageId));
  for (const { messageId } of unshown) shown.add(messageId);
  return {
    ...event,
    payload: { ...event.payload, text: baseText ?? event.payload.text, messages: unshown },
  };
};

// An ACP plan update sends the whole plan; a tool call update sends only the changed fields.
const firstKeyOf = ({ attemptId, update }: AgentUpdateEvent["payload"]) => {
  const toolCallId = toolCallIdOf(update);
  if (toolCallId !== undefined) return `${attemptId}/tool/${toolCallId}`;
  if (update.sessionUpdate === "plan") return `${attemptId}/plan`;
  return undefined;
};

const updateFirst = (first: AgentUpdateEvent, event: AgentUpdateEvent) => {
  const { update } = event.payload;
  if (toolCallIdOf(update) === undefined) return event;
  const merged = { ...first.payload.update, ...definedFields(update) };
  return withUpdate(first, { ...merged, sessionUpdate: "tool_call" });
};

export const attemptItemsOf = (items: TranscriptItem[], attemptId: number | undefined) => {
  const all = items.filter(
    ({ event }) => event.payload.attemptId === attemptId && event.kind !== "attempt_started",
  );
  return { all, visible: all.filter(({ event }) => !isSystemEvent(event)) };
};

export class Transcript {
  private items: TranscriptItem[] = [];
  private readonly firstIndexByKey = new Map<string, number>();
  private readonly shownMessages = new Set<number>();
  private lastSeq = 0;

  // Gives a new list in which only the items that the batch changes are new objects.
  add(events: readonly StoredRunEvent[]): TranscriptItem[] {
    const items = [...this.items];
    for (const { seq, event } of events) {
      if (seq <= this.lastSeq) continue;
      this.lastSeq = seq;
      const lastIndex = items.length - 1;
      const last = items[lastIndex];
      const joined = last && mergeRunEvents(last.event, event);
      if (last && joined) {
        items[lastIndex] = { seq: last.seq, event: joined };
        continue;
      }
      if (event.kind === "agent_prompt") {
        items.push({ seq, event: chatPrompt(event, this.shownMessages) });
        continue;
      }
      if (event.kind !== "agent_update") {
        items.push({ seq, event });
        continue;
      }
      const key = firstKeyOf(event.payload);
      const index = key === undefined ? undefined : this.firstIndexByKey.get(key);
      const first = index === undefined ? undefined : items[index];
      if (index !== undefined && first?.event.kind === "agent_update") {
        items[index] = { seq: first.seq, event: updateFirst(first.event, event) };
        continue;
      }
      if (key !== undefined) this.firstIndexByKey.set(key, items.length);
      items.push({ seq, event });
    }
    this.items = items;
    return items;
  }
}
