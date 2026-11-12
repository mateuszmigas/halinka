import { describe, expect, it } from "vitest";

import { workflowGraph } from "./workflowGraph";

const sourceOf = (...ids: string[]) =>
  `schema_version: 1\nname: Build\nsteps:\n${ids.map((id) => `  - id: ${id}\n    type: shell\n    run: echo hello`).join("\n")}\n`;

describe("workflowGraph", () => {
  it("keeps node keys when source changes the order", () => {
    const first = workflowGraph(sourceOf("first", "second"));

    const changed = workflowGraph(sourceOf("second", "first"), first);

    expect(changed.entries.map((entry) => entry.key)).toEqual([
      first.entries[1]!.key,
      first.entries[0]!.key,
    ]);
  });

  it("assigns a new node key when an ID is ambiguous", () => {
    const first = workflowGraph(sourceOf("first"));

    const changed = workflowGraph(sourceOf("first", "first"), first);

    expect(new Set(changed.entries.map((entry) => entry.key)).size).toBe(2);
    expect(changed.entries.map((entry) => entry.key)).not.toContain(first.entries[0]!.key);
  });

  it("retains keys for recovery but marks invalid YAML unreadable", () => {
    const first = workflowGraph(sourceOf("first"));

    const changed = workflowGraph("name: [", first);

    expect(changed.isReadable).toBe(false);
    expect(workflowGraph(sourceOf("first"), changed).entries[0]!.key).toBe(first.entries[0]!.key);
  });

  it("addresses a loop child within its parent", () => {
    const graph = workflowGraph(
      "schema_version: 1\nname: Build\nsteps:\n  - id: repeat\n    type: loop\n    max_iterations: 2\n    until: ${{ true }}\n    steps:\n      - id: child\n        type: shell\n        run: echo hello\n",
    );

    expect(graph.entries[1]).toMatchObject({
      id: "child",
      index: 0,
      parent: 0,
    });
  });

  it.each(["", "second"])("preserves an explicit edit key for ID %j", (id) => {
    const first = workflowGraph(sourceOf("first", "second"));

    const changed = workflowGraph(sourceOf(id, "second"), first, {
      index: 0,
      key: first.entries[0]!.key,
    });

    expect(changed.entries[0]!.key).toBe(first.entries[0]!.key);
  });
});
