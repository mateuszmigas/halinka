import type { RunEvent } from "@halinka/server/client";
import { describe, expect, it } from "vitest";

import { RunPrinter } from "./runPrinter";

const ofAttempt = { stepId: "build", attemptId: 1 };

const setUp = () => {
  const out: string[] = [];
  const err: string[] = [];
  const printer = new RunPrinter(
    { write: (text) => out.push(text) },
    { write: (text) => err.push(text) },
  );
  return { printer, stdout: () => out.join(""), stderr: () => err.join("") };
};

const output = (text: string, stream: "stdout" | "stderr" = "stdout"): RunEvent => ({
  kind: "output",
  payload: { ...ofAttempt, stream, text },
});

const agentUpdate = (update: { sessionUpdate: string; content: unknown }): RunEvent => ({
  kind: "agent_update",
  payload: { ...ofAttempt, update },
});

describe("RunPrinter", () => {
  it("writes each stream of a command to the same stream", () => {
    const { printer, stdout, stderr } = setUp();

    printer.event(output("out\n"));
    printer.event(output("err\n", "stderr"));

    expect(stdout()).toBe("out\n");
    expect(stderr()).toBe("err\n");
  });

  it("starts a line of Halinka on a new line after output without a line end", () => {
    const { printer, stdout } = setUp();

    printer.event(output("no line end"));
    printer.line("Run 1: succeeded");

    expect(stdout()).toBe("no line end\nRun 1: succeeded\n");
  });

  it("removes terminal control sequences from output", () => {
    const { printer, stdout } = setUp();

    printer.event(output("\u001b]0;title\u0007\u001b[31mred\u001b[0m\n"));

    expect(stdout()).toBe("red\n");
  });

  it("prints the text of an agent message", () => {
    const { printer, stdout } = setUp();

    printer.event(
      agentUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Done" },
      }),
    );

    expect(stdout()).toBe("Done");
  });

  it("does not print the thoughts of an agent", () => {
    const { printer, stdout } = setUp();

    printer.event(
      agentUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Hmm" },
      }),
    );

    expect(stdout()).toBe("");
  });

  it("prints the error of a finished attempt", () => {
    const { printer, stdout } = setUp();

    printer.event({
      kind: "attempt_finished",
      payload: { ...ofAttempt, status: "failed", error: "No space" },
    });

    expect(stdout()).toBe("Step build: failed: No space\n");
  });

  it.each([
    [0, "Gate lint: passed\n"],
    [2, "Gate lint: failed, exit code 2\n"],
    [undefined, "Gate lint: failed\n"],
  ])("prints the gate that ends with the exit code %s", (exitCode, line) => {
    const { printer, stdout } = setUp();

    printer.event({ kind: "gate_finished", payload: { ...ofAttempt, name: "lint", exitCode } });

    expect(stdout()).toBe(line);
  });

  it("prints the start of an attempt", () => {
    const { printer, stdout } = setUp();

    printer.event({ kind: "attempt_started", payload: { ...ofAttempt, stepRunId: 1, attempt: 2 } });

    expect(stdout()).toBe("Step build: attempt 2 started\n");
  });

  it("prints that the engine left out output", () => {
    const { printer, stdout } = setUp();

    printer.event({ kind: "output_cut", payload: { ...ofAttempt, length: 5 } });

    expect(stdout()).toBe("Halinka left out 5 characters of the output.\n");
  });

  it("keeps the line state after output of only control sequences", () => {
    const { printer, stdout } = setUp();

    printer.event(output("no line end"));
    printer.event(output("\u001b[0m"));
    printer.line("Run 1: succeeded");

    expect(stdout()).toBe("no line end\nRun 1: succeeded\n");
  });
});
