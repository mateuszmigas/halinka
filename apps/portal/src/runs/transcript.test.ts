import type { RunEvent, StoredRunEvent } from "@halinka/server/client";
import { describe, expect, it } from "vitest";

import type { AgentUpdate } from "./agentUpdate";
import { attemptItemsOf, Transcript } from "./transcript";

const agentUpdate = (update: AgentUpdate, attemptId = 1): RunEvent => ({
  kind: "agent_update",
  payload: { stepId: "build", attemptId, update },
});

const stored = (...events: RunEvent[]): StoredRunEvent[] =>
  events.map((event, index) => ({ seq: index + 1, createdAt: "", event }));

const storedAt = (seq: number, event: RunEvent): StoredRunEvent => ({ seq, createdAt: "", event });

const messageChunk = (text: string) =>
  agentUpdate({
    sessionUpdate: "agent_message_chunk",
    messageId: "m1",
    content: { type: "text", text },
  });

const toolCall = (fields: Record<string, unknown>, attemptId = 1) =>
  agentUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", ...fields }, attemptId);

const toolCallUpdate = (fields: Record<string, unknown>, attemptId = 1) =>
  agentUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", ...fields }, attemptId);

const plan = (status: string, attemptId = 1) =>
  agentUpdate({ sessionUpdate: "plan", entries: [{ content: "Fix", status }] }, attemptId);

const prompt = (baseText: string, messages: [number, string][]): RunEvent => ({
  kind: "agent_prompt",
  payload: {
    stepId: "build",
    attemptId: 1,
    text: [baseText, ...messages.map(([, text]) => `Message from local:\n${text}`)]
      .filter(Boolean)
      .join("\n\n"),
    baseText,
    messages: messages.map(([messageId, text]) => ({ messageId, author: "local", text })),
  },
});

const toTranscript = (events: StoredRunEvent[]) => new Transcript().add(events);

describe("Transcript", () => {
  it("shows the base text of a prompt with messages", () => {
    const items = toTranscript(stored(prompt("Fix the bug", [[1, "A"]])));

    expect(items).toMatchObject([
      { event: { payload: { text: "Fix the bug", messages: [{ messageId: 1 }] } } },
    ]);
  });

  it("shows a message one time when a later prompt sends it again", () => {
    const items = toTranscript(
      stored(
        prompt("", [[1, "A"]]),
        prompt("Continue", [
          [1, "A"],
          [2, "B"],
        ]),
      ),
    );

    expect(items[1]).toMatchObject({
      event: { payload: { text: "Continue", messages: [{ messageId: 2 }] } },
    });
  });

  it("keeps the seq of the first chunk of a joined message", () => {
    const items = toTranscript(stored(messageChunk("Hel"), messageChunk("lo")));

    expect(items).toEqual([{ seq: 1, event: messageChunk("Hello") }]);
  });

  it("shows a tool call where it started, with the status of its last update", () => {
    const items = toTranscript(
      stored(
        toolCall({ title: "Read", status: "pending" }),
        messageChunk("Reading"),
        toolCallUpdate({ status: "completed" }),
      ),
    );

    expect(items).toEqual([
      { seq: 1, event: toolCall({ title: "Read", status: "completed" }) },
      { seq: 2, event: messageChunk("Reading") },
    ]);
  });

  it("keeps a tool call field that a later update sets to null", () => {
    const items = toTranscript(
      stored(toolCall({ title: "Read" }), toolCallUpdate({ title: null })),
    );

    expect(items).toEqual([{ seq: 1, event: toolCall({ title: "Read" }) }]);
  });

  it("shows a tool call of each attempt separately", () => {
    const items = toTranscript(
      stored(toolCall({ title: "Read" }, 1), toolCall({ title: "Read" }, 2)),
    );

    expect(items.map(({ seq }) => seq)).toEqual([1, 2]);
  });

  it("shows the last plan of an attempt where the first plan was", () => {
    const items = toTranscript(stored(plan("pending"), messageChunk("Fixing"), plan("completed")));

    expect(items).toEqual([
      { seq: 1, event: plan("completed") },
      { seq: 2, event: messageChunk("Fixing") },
    ]);
  });

  it("shows the plans of each attempt separately", () => {
    const items = toTranscript(stored(plan("pending", 1), plan("completed", 2)));

    expect(items).toEqual([
      { seq: 1, event: plan("pending", 1) },
      { seq: 2, event: plan("completed", 2) },
    ]);
  });

  it("gives the same items when the events come in two batches", () => {
    const events = stored(
      prompt("", [[1, "A"]]),
      toolCall({ title: "Read", status: "pending" }),
      messageChunk("Hel"),
      messageChunk("lo"),
      toolCallUpdate({ status: "completed" }),
      prompt("Continue", [
        [1, "A"],
        [2, "B"],
      ]),
    );
    const transcript = new Transcript();

    transcript.add(events.slice(0, 3));
    const items = transcript.add(events.slice(3));

    expect(items).toEqual(toTranscript(events));
  });

  it("keeps the objects of the items that a batch does not change", () => {
    const transcript = new Transcript();
    const [first] = transcript.add(stored(toolCall({ title: "Read" })));

    const items = transcript.add([storedAt(2, messageChunk("A"))]);

    expect(items[0]).toBe(first);
  });

  it("gives a new object for an item that a batch changes", () => {
    const transcript = new Transcript();
    const [first] = transcript.add(stored(toolCall({ title: "Read", status: "pending" })));

    const items = transcript.add([storedAt(2, toolCallUpdate({ status: "completed" }))]);

    expect(items[0]).not.toBe(first);
    expect(items[0]).toEqual({ seq: 1, event: toolCall({ title: "Read", status: "completed" }) });
  });

  it("ignores an event that it got before", () => {
    const transcript = new Transcript();
    transcript.add(stored(messageChunk("A")));

    const items = transcript.add(stored(messageChunk("A")));

    expect(items).toEqual([{ seq: 1, event: messageChunk("A") }]);
  });

  it("keeps only the events of the given attempt", () => {
    const items = toTranscript(stored(messageChunk("a"), toolCall({ title: "ls" }, 2)));

    expect(attemptItemsOf(items, 2).all.map(({ event }) => event)).toEqual([
      toolCall({ title: "ls" }, 2),
    ]);
  });

  it("leaves out the start of the attempt, which its tab shows", () => {
    const started: RunEvent = {
      kind: "attempt_started",
      payload: { stepId: "build", attemptId: 1, stepRunId: 1, attempt: 1 },
    };
    const items = toTranscript(stored(started, messageChunk("a")));

    expect(attemptItemsOf(items, 1).all.map(({ event }) => event)).toEqual([messageChunk("a")]);
  });

  it("leaves the system events out of the visible events", () => {
    const usage = agentUpdate({ sessionUpdate: "usage_update", used: 1 });
    const items = toTranscript(stored(usage, messageChunk("a")));

    expect(attemptItemsOf(items, 1).visible.map(({ event }) => event)).toEqual([messageChunk("a")]);
  });
});
