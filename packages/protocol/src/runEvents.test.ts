import { describe, expect, it } from "vitest";

import { mergeRunEvents, type RunEvent, textChunkOf } from "./runEvents";

type Update = { sessionUpdate: string } & Record<string, unknown>;

type Attempt = { stepId: string; attemptId: number };

const firstAttempt: Attempt = { stepId: "a1", attemptId: 1 };

const agentUpdate = (update: Update, attempt = firstAttempt): RunEvent => ({
  kind: "agent_update",
  payload: { ...attempt, update },
});

const output = (
  text: string,
  fields: Partial<Extract<RunEvent, { kind: "output" }>["payload"]> = {},
): RunEvent => ({
  kind: "output",
  payload: { ...firstAttempt, stream: "stdout", text, ...fields },
});

const chunk = (text: string, fields: Record<string, unknown> = {}, attempt = firstAttempt) =>
  agentUpdate(
    {
      sessionUpdate: "agent_message_chunk",
      messageId: "m1",
      content: { type: "text", text },
      ...fields,
    },
    attempt,
  );

describe("runEvents", () => {
  it.each(["agent_message_chunk", "agent_thought_chunk"])(
    "merges two %s updates of one message",
    (sessionUpdate) => {
      expect(
        mergeRunEvents(chunk("Hel", { sessionUpdate }), chunk("lo", { sessionUpdate })),
      ).toEqual(chunk("Hello", { sessionUpdate }));
    },
  );

  it("merges two chunks whose _meta and annotations are null", () => {
    const nullChunk = (text: string) =>
      chunk(text, { _meta: null, content: { type: "text", text, _meta: null, annotations: null } });

    expect(mergeRunEvents(nullChunk("Hel"), nullChunk("lo"))).toEqual(nullChunk("Hello"));
  });

  it.each([
    { name: "one is not a chunk", second: agentUpdate({ sessionUpdate: "plan", entries: [] }) },
    {
      name: "one is not an agent update",
      first: { kind: "agent_prompt", payload: { stepId: "a1", attemptId: 1, text: "a" } },
      second: chunk("b"),
    },
    { name: "their messageId differs", second: chunk("b", { messageId: "m2" }) },
    { name: "their attempt differs", second: chunk("b", {}, { stepId: "a1", attemptId: 2 }) },
    { name: "their step differs", second: chunk("b", {}, { stepId: "a2", attemptId: 1 }) },
    {
      name: "the chunks have no messageId",
      first: chunk("a", { messageId: null }),
      second: chunk("b", { messageId: null }),
    },
    { name: "one is a thought", second: chunk("b", { sessionUpdate: "agent_thought_chunk" }) },
    { name: "one has _meta", second: chunk("b", { _meta: { source: "x" } }) },
    {
      name: "its content has _meta",
      second: chunk("b", { content: { type: "text", text: "b", _meta: { source: "x" } } }),
    },
    {
      name: "its content has annotations",
      second: chunk("b", { content: { type: "text", text: "b", annotations: {} } }),
    },
    {
      name: "its content is not text",
      second: chunk("b", { content: { type: "image", data: "", mimeType: "image/png" } }),
    },
    { name: "one has a field that the rule does not know", second: chunk("b", { extra: 1 }) },
  ] as { name: string; first?: RunEvent; second: RunEvent }[])(
    "does not merge two updates when $name",
    ({ first = chunk("a"), second }) => {
      expect(mergeRunEvents(first, second)).toBeUndefined();
    },
  );

  it("merges two outputs of one stream and gate", () => {
    const gate = "tests";

    expect(mergeRunEvents(output("a\n", { gate }), output("b\n", { gate }))).toEqual(
      output("a\nb\n", { gate }),
    );
  });

  it("merges two outputs up to 65536 characters of text", () => {
    const text = "b".repeat(64 * 1024 - 1);

    expect(mergeRunEvents(output("a"), output(text))).toEqual(output(`a${text}`));
  });

  it.each([
    { name: "their stream differs", second: output("b", { stream: "stderr" }) },
    { name: "their gate differs", second: output("b", { gate: "tests" }) },
    { name: "their attempt differs", second: output("b", { attemptId: 2 }) },
    { name: "the text gets longer than 65536 characters", second: output("b".repeat(64 * 1024)) },
  ])("does not merge two outputs when $name", ({ second }) => {
    expect(mergeRunEvents(output("a"), second)).toBeUndefined();
  });

  it("gives the text of a text chunk", () => {
    const update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } };

    expect(textChunkOf(update)).toEqual({ sessionUpdate: "agent_message_chunk", text: "Hi" });
  });

  it("gives no text chunk for content that is not text", () => {
    const update = { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "" } };

    expect(textChunkOf(update)).toBeUndefined();
  });
});
