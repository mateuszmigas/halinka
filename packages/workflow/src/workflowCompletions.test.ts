import { describe, expect, it } from "vitest";

import { workflowCompletions } from "./workflowCompletions";

const cursor = "¦";

const completionsAt = (lines: string[]) => {
  const text = lines.join("\n");
  const offset = text.indexOf(cursor);
  return workflowCompletions(text.replace(cursor, ""), offset);
};

const labelsAt = (lines: string[]) => completionsAt(lines).items.map((item) => item.label);

const shellStep = ["steps:", "  - id: build", "    type: shell", "    run: ls"];

describe("workflowCompletions", () => {
  it("offers the top keys in an empty file", () => {
    expect(labelsAt([cursor])).toEqual([
      "name",
      "inputs",
      "on",
      "branch",
      "runs-on",
      "max_cost_usd",
      "concurrency",
      "steps",
    ]);
  });

  it("leaves out a key that the map has", () => {
    expect(labelsAt(["name: Fix", cursor, ...shellStep])).toEqual([
      "inputs",
      "on",
      "branch",
      "runs-on",
      "max_cost_usd",
      "concurrency",
    ]);
  });

  it("offers only the keys of the type of the step", () => {
    const labels = labelsAt(["name: Fix", ...shellStep, `    ${cursor}`]);

    expect(labels).toEqual(["if", "network", "timeout"]);
  });

  it("offers the keys of all types for a step with no type", () => {
    const labels = labelsAt(["name: Fix", "steps:", `  - ${cursor}`]);

    expect(labels).toEqual(
      expect.arrayContaining(["id", "type", "run", "prompt", "max_iterations"]),
    );
  });

  it("offers the step types as values of type", () => {
    const labels = labelsAt(["steps:", "  - id: fix", `    type: ${cursor}`]);

    expect(labels).toEqual(["shell", "agent", "approval", "github", "loop"]);
  });

  it("offers the keys of a child step of a loop", () => {
    const lines = [
      "steps:",
      "  - id: again",
      "    type: loop",
      "    steps:",
      "      - id: fix",
      "        type: approval",
      `        ${cursor}`,
    ];

    expect(labelsAt(lines)).toEqual(["if", "message", "reviewers"]);
  });

  it("offers the actions of a gate as values of on_fail", () => {
    const lines = [
      "steps:",
      "  - id: fix",
      "    type: agent",
      "    gates:",
      "      - name: test",
      `        on_fail: ${cursor}`,
    ];

    expect(labelsAt(lines)).toEqual(["retry", "ask_human", "fail"]);
  });

  it("offers the values of a list item", () => {
    const lines = ["on:", "  issues:", "    types:", `      - ${cursor}`];

    expect(labelsAt(lines)).toEqual(["opened", "reopened", "labeled"]);
  });

  it("offers true and false for a boolean", () => {
    const lines = ["steps:", "  - id: fix", "    type: agent", `    require_changes: ${cursor}`];

    expect(labelsAt(lines)).toEqual(["true", "false"]);
  });

  it("offers nothing in a block of text", () => {
    const lines = ["steps:", "  - id: fix", "    type: shell", "    run: |", `      ${cursor}`];

    expect(labelsAt(lines)).toEqual([]);
  });

  it("offers nothing in a comment", () => {
    expect(labelsAt([`# note: ${cursor}`])).toEqual([]);
  });

  it("offers the values of a key in a flow map", () => {
    expect(labelsAt([`steps: [{ id: fix, type: ${cursor}}]`])).toEqual([
      "shell",
      "agent",
      "approval",
      "github",
      "loop",
    ]);
  });

  it("offers nothing for a key in a flow map", () => {
    expect(labelsAt([`steps: [{ id: fix, ${cursor}}]`])).toEqual([]);
  });

  it("offers the fields of a named input", () => {
    expect(labelsAt(["inputs:", "  issue:", `    type: ${cursor}`])).toEqual([
      "string",
      "number",
      "boolean",
    ]);
  });

  it("offers nothing under outputs", () => {
    const lines = ["steps:", "  - id: fix", "    type: agent", "    outputs:", `      ${cursor}`];

    expect(labelsAt(lines)).toEqual([]);
  });

  it("offers nothing under outcomes", () => {
    const lines = ["steps:", "  - id: fix", "    type: agent", "    outcomes:", `      ${cursor}`];

    expect(labelsAt(lines)).toEqual([]);
  });

  it("gives an empty range on an empty first line above other text", () => {
    const { start, end } = completionsAt([cursor, "name: Fix"]);

    expect({ start, end }).toEqual({ start: 0, end: 0 });
  });

  it("offers nothing in the middle of a text value", () => {
    expect(labelsAt([`name: my ${cursor}`])).toEqual([]);
  });

  it("offers keys in a file with an error in another part", () => {
    const lines = [
      "name: a",
      "name: b",
      "steps:",
      "  - id: fix",
      "    type: shell",
      `    ${cursor}`,
    ];

    expect(labelsAt(lines)).toEqual(["if", "run", "network", "timeout"]);
  });

  it("gives the range of a word with a hyphen", () => {
    const { start, end } = completionsAt([`runs-${cursor}o`]);

    expect({ start, end }).toEqual({ start: 0, end: 6 });
  });

  it("adds a colon and a space to a new key", () => {
    const { items } = completionsAt([cursor]);

    expect(items[0]).toEqual({ label: "name", insertText: "name: ", kind: "key" });
  });

  it("does not add a colon to a key with a space before its colon", () => {
    const { items } = completionsAt([`na${cursor}me : Fix`]);

    expect(items[0]).toEqual({ label: "name", insertText: "name", kind: "key" });
  });

  it("does not add a colon to a key that has one", () => {
    const { items } = completionsAt([`na${cursor}me: Fix`]);

    expect(items[0]).toEqual({ label: "name", insertText: "name", kind: "key" });
  });
});
