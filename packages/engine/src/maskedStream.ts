import type { AgentEvent } from "@halinka/agents";

import type { LentValues } from "./checkpoints";

// Keeps the raw end that can start a lent value until the next chunk.
export class MaskedStream {
  private held = "";

  constructor(private readonly lent: LentValues) {}

  push(text: string) {
    const raw = this.held + text;
    const cut = raw.length - this.lent.heldLength(raw);
    this.held = raw.slice(cut);
    return this.lent.mask(raw.slice(0, cut));
  }

  end() {
    const rest = this.held;
    this.held = "";
    return this.lent.mask(rest);
  }
}

type TextChunk = Extract<
  AgentEvent,
  { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" }
> & { content: { type: "text" } };

const isTextChunk = (update: AgentEvent): update is TextChunk =>
  (update.sessionUpdate === "agent_message_chunk" ||
    update.sessionUpdate === "agent_thought_chunk") &&
  update.content.type === "text";

const withText = (chunk: TextChunk, text: string): TextChunk => ({
  ...chunk,
  content: { ...chunk.content, text },
});

export class MaskedAgentText {
  private current: { key: string; last: TextChunk; stream: MaskedStream } | undefined;

  constructor(private readonly lent: LentValues) {}

  push(update: AgentEvent): AgentEvent[] {
    if (!isTextChunk(update)) return [...this.end(), update];
    const key = `${update.sessionUpdate} ${update.messageId ?? ""}`;
    const ended = this.current?.key === key ? [] : this.end();
    const stream = this.current?.stream ?? new MaskedStream(this.lent);
    this.current = { key, last: update, stream };
    const text = stream.push(update.content.text);
    if (!text) return ended;
    return [...ended, text === update.content.text ? update : withText(update, text)];
  }

  end(): AgentEvent[] {
    const { current } = this;
    this.current = undefined;
    const text = current?.stream.end();
    return current && text ? [withText(current.last, text)] : [];
  }
}
