import type { AgentEvent } from "@halinka/agents";
import { describe, expect, it } from "vitest";

import { MaskedAgentText, MaskedStream } from "./maskedStream";
import { keepAll, masking } from "./testing";

const lentValue = "sk-lent-value-1";

const lent = masking(lentValue);

const streamed = (stream: MaskedStream, chunks: string[]) =>
  [...chunks.map((chunk) => stream.push(chunk)), stream.end()].join("");

const chunk = (
  messageId: string,
  text: string,
  sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" = "agent_message_chunk",
): AgentEvent => ({ sessionUpdate, messageId, content: { type: "text", text } });

const textOf = (updates: AgentEvent[]) =>
  updates.map((update) =>
    (update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk") &&
    update.content.type === "text"
      ? `${update.messageId}: ${update.content.text}`
      : update.sessionUpdate,
  );

describe("MaskedStream", () => {
  it("masks a lent value at each split into two chunks", () => {
    const text = `a ${lentValue} b ${lentValue}`;

    const results = new Set(
      Array.from({ length: text.length + 1 }, (_, cut) =>
        streamed(new MaskedStream(lent), [text.slice(0, cut), text.slice(cut)]),
      ),
    );

    expect([...results]).toEqual(["a *** b ***"]);
  });

  it("keeps the end that can start a lent value until the end of the stream", () => {
    const stream = new MaskedStream(lent);

    const now = stream.push("token sk-le");

    expect({ now, rest: stream.end() }).toEqual({ now: "token ", rest: "sk-le" });
  });

  it("gives text at once when no end of it can start a lent value", () => {
    const stream = new MaskedStream(lent);

    expect(stream.push("tests passed\n")).toBe("tests passed\n");
  });

  it("keeps nothing without lent values", () => {
    const stream = new MaskedStream(keepAll);

    expect(stream.push("sk-le")).toBe("sk-le");
  });

  it("masks a lent value that two chunks of one agent message split", () => {
    const text = new MaskedAgentText(lent);

    const updates = [
      ...text.push(chunk("m1", "token sk-lent")),
      ...text.push(chunk("m1", "-value-1 done")),
      ...text.end(),
    ];

    expect(textOf(updates)).toEqual(["m1: token ", "m1: *** done"]);
  });

  it("gives the held text of an agent message before the next message and before other updates", () => {
    const text = new MaskedAgentText(lent);

    const updates = [
      ...text.push(chunk("m1", "first sk-")),
      ...text.push(chunk("m2", "second sk-")),
      ...text.push({ sessionUpdate: "plan", entries: [] }),
    ];

    expect(textOf(updates)).toEqual(["m1: first ", "m1: sk-", "m2: second ", "m2: sk-", "plan"]);
  });

  it("gives the held text of an agent message before a thought chunk of the same message", () => {
    const text = new MaskedAgentText(lent);

    const updates = [
      ...text.push(chunk("m1", "answer sk-")),
      ...text.push(chunk("m1", "thought", "agent_thought_chunk")),
    ];

    expect(textOf(updates)).toEqual(["m1: answer ", "m1: sk-", "m1: thought"]);
  });

  it("gives an agent update without a lent value as it is", () => {
    const text = new MaskedAgentText(lent);
    const update = chunk("m1", "done");

    expect(text.push(update)[0]).toBe(update);
  });
});
