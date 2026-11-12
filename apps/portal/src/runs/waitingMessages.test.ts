import type { RunEvent } from "@halinka/server/client";
import { describe, expect, it } from "vitest";

import { waitingMessages } from "./waitingMessages";

const message = {
  id: 1,
  stepRunId: 2,
  text: "Use SQLite",
  author: "local",
  createdAt: "",
};

const stepRun = (status: string) => ({ id: 2, status });

const deliveringPrompt: RunEvent = {
  kind: "agent_prompt",
  payload: {
    stepId: "implement",
    attemptId: 3,
    text: "",
    messages: [{ messageId: 1, author: "local", text: "Use SQLite" }],
  },
};

describe("waitingMessages", () => {
  it("marks a message of a running step run as waiting", () => {
    const run = { undeliveredMessages: [message], stepRuns: [stepRun("running")] };

    expect(waitingMessages(run, [])).toMatchObject([{ id: 1, isWaiting: true }]);
  });

  it("marks a message of an ended step run as not waiting", () => {
    const run = { undeliveredMessages: [message], stepRuns: [stepRun("succeeded")] };

    expect(waitingMessages(run, [])).toMatchObject([{ id: 1, isWaiting: false }]);
  });

  it("leaves out a message that a prompt delivered after the run was read", () => {
    const run = { undeliveredMessages: [message], stepRuns: [stepRun("running")] };

    expect(waitingMessages(run, [{ seq: 1, event: deliveringPrompt }])).toEqual([]);
  });
});
