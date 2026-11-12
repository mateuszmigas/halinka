import { describe, expect, it } from "vitest";

import { isSystemEvent, planOf, toolCallOf } from "./agentUpdate";

describe("agentUpdate", () => {
  it("drops a tool call status that ACP does not define", () => {
    const update = { sessionUpdate: "tool_call", toolCallId: "t1", status: "waiting" };

    expect(toolCallOf(update)?.status).toBeUndefined();
  });

  it("keeps only the text content and the diff paths of a tool call", () => {
    const update = {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      content: [
        { type: "content", content: { type: "text", text: "1" } },
        { type: "diff", path: "/a.ts", newText: "2" },
        { type: "terminal", terminalId: "x" },
      ],
    };

    expect(toolCallOf(update)?.content).toEqual([
      { type: "text", text: "1" },
      { type: "diff", path: "/a.ts" },
    ]);
  });

  it("drops a plan entry with a status that ACP does not define", () => {
    const update = {
      sessionUpdate: "plan",
      entries: [
        { content: "Read", status: "completed" },
        { content: "Fix", status: "blocked" },
      ],
    };

    expect(planOf(update)).toEqual([{ content: "Read", status: "completed" }]);
  });

  it("counts a usage update as a system event", () => {
    const update = { sessionUpdate: "usage_update", used: 10 };

    expect(
      isSystemEvent({ kind: "agent_update", payload: { stepId: "a", attemptId: 1, update } }),
    ).toBe(true);
  });

  it("counts an agent session as a system event", () => {
    const event = {
      kind: "agent_session" as const,
      payload: { stepId: "a", attemptId: 1, sessionId: "s" },
    };

    expect(isSystemEvent(event)).toBe(true);
  });

  it("does not count a tool call as a system event", () => {
    const update = { sessionUpdate: "tool_call", toolCallId: "t1" };

    expect(
      isSystemEvent({ kind: "agent_update", payload: { stepId: "a", attemptId: 1, update } }),
    ).toBe(false);
  });
});
