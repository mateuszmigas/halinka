import { describe, expect, it } from "vitest";

import { editSteps, parseStepFields, type StepEdit } from "./editSteps";
import type { StepField } from "./formFields";
import { parseWorkflow } from "./workflow";

const sourceOf = (...steps: string[]) =>
  `schema_version: 1\nname: Build\nsteps:\n${steps.join("\n")}\n`;
const shell = (id = "build", run = "echo hello") =>
  `  - id: ${id}\n    type: shell\n    run: ${run}`;
const agent = (id = "implement") =>
  `  - id: ${id}\n    type: agent\n    agent: claude-code\n    prompt: Implement the task`;
const approval = "  - id: approve\n    type: approval\n    message: Review the code";
const editedSource = (source: string, edit: StepEdit) => {
  const result = editSteps(source, edit);
  if (!result.ok) throw new Error(result.problems.join(" "));
  return result.value;
};

describe("editSteps", () => {
  it("reads shell fields while a required value is empty", () => {
    const source = sourceOf(`${shell("build", '""')}\n    timeout: 5m`);

    expect(parseStepFields(source)).toMatchObject([
      { id: "build", type: "shell", run: "", if: "", timeout: "5m" },
    ]);
  });

  it("reads an aliased command", () => {
    const source = sourceOf(shell("first", "&command echo hello"), shell("second", "*command"));

    expect(parseStepFields(source)?.[1]?.run).toBe("echo hello");
  });

  it("edits a step whose type is an alias", () => {
    const source = sourceOf(
      shell("first").replace("type: shell", "type: &kind shell"),
      shell("second").replace("type: shell", "type: *kind"),
    );

    const edited = editedSource(source, {
      type: "set",
      index: 1,
      field: "run",
      value: "pnpm test",
    });

    expect(parseStepFields(edited)?.[1]?.run).toBe("pnpm test");
    expect(edited).toContain("*kind");
  });

  it.each<StepEdit>([
    { type: "set", index: 0, field: "id", value: "build" },
    { type: "move", index: 0, to: 0 },
    { type: "set_gate", index: 0, gate: 0, field: "name", value: "tests" },
  ])("keeps the source unchanged when the edit changes no value: $type", (edit) => {
    const source = sourceOf(
      `${agent("build")}\n    gates:\n      - name:   tests\n        run: pnpm test`,
    ).replace("id: build", "id:   build");

    expect(editedSource(source, edit)).toBe(source);
  });

  const unreadable = [
    "name: [",
    "",
    "- build",
    "schema_version: 1\nname: Build\nsteps: {}",
    "schema_version: 1\nname: Build\nsteps: [null]",
  ];

  it.each(unreadable)("reads no fields from an unreadable step list: %s", (source) => {
    expect(parseStepFields(source)).toBeUndefined();
  });

  it.each(unreadable)("refuses to edit an unreadable step list: %s", (source) => {
    expect(editSteps(source, { type: "add_shell" })).toEqual({
      ok: false,
      problems: ["Use the YAML editor to correct the step list."],
    });
  });

  it("updates a shell command without changing other step fields", () => {
    const source = sourceOf(`${shell()}\n    timeout: 5m`);

    const edited = editedSource(source, {
      type: "set",
      index: 0,
      field: "run",
      value: "pnpm build\npnpm test\n",
    });

    expect(parseWorkflow(edited)).toEqual({
      ok: true,
      value: {
        name: "Build",
        steps: [{ id: "build", type: "shell", run: "pnpm build\npnpm test\n", timeout: "5m" }],
      },
    });
  });

  it("keeps an empty required field so the parser reports its path", () => {
    const edited = editedSource(sourceOf(shell()), {
      type: "set",
      index: 0,
      field: "id",
      value: "",
    });

    const result = parseWorkflow(edited);

    expect(result).toMatchObject({ ok: false, problems: [{ path: ["steps", 0, "id"] }] });
  });

  it.each(["if", "timeout"] as const)("removes the optional %s field when it is empty", (field) => {
    const source = sourceOf(`${shell()}\n    ${field}: ${field === "if" ? '"${{ true }}"' : "5m"}`);

    const edited = editedSource(source, { type: "set", index: 0, field, value: "" });

    expect(edited).not.toContain(`    ${field}:`);
    expect(parseWorkflow(edited).ok).toBe(true);
  });

  it("preserves comments and anchors when a form changes a field", () => {
    const source = `# Build checks\n${sourceOf(
      `${shell("first", "&command echo hello # shared command")}\n    timeout: 5m # deadline`,
      shell("second", "*command"),
    )}`;

    const edited = editedSource(source, { type: "set", index: 0, field: "timeout", value: "10m" });

    expect(edited).toContain("# Build checks");
    expect(edited).toContain("&command echo hello # shared command");
    expect(edited).toContain("10m # deadline");
    expect(edited).toContain("*command");
    expect(parseWorkflow(edited).ok).toBe(true);
  });

  it("adds a shell step with an ID that no loop child uses", () => {
    const source = sourceOf(
      "  - id: repeat\n    type: loop\n    max_iterations: 1\n    until: ${{ true }}\n    steps:\n      - id: shell_1\n        type: shell\n        run: echo hello",
    );

    const edited = editedSource(source, { type: "add_shell" });

    expect(parseStepFields(edited)?.[1]).toMatchObject({
      id: "shell_2",
      type: "shell",
      run: "echo hello",
    });
    expect(parseWorkflow(edited).ok).toBe(true);
  });

  it("adds a shell step to an empty list", () => {
    const edited = editedSource("schema_version: 1\nname: Build\nsteps: []\n", {
      type: "add_shell",
    });

    expect(parseStepFields(edited)).toMatchObject([{ id: "shell_1", type: "shell" }]);
  });

  it("moves a step with its comment", () => {
    const source = sourceOf(shell("first"), `  # Keep this check\n${shell("second")}`);

    const edited = editedSource(source, { type: "move", index: 1, to: 0 });

    expect(parseStepFields(edited)?.map((step) => step.id)).toEqual(["second", "first"]);
    expect(edited).toMatch(/# Keep this check\n\s+- id: second/);
  });

  it("removes only the selected step", () => {
    const source = sourceOf(shell("first"), shell("second"));

    const edited = editedSource(source, { type: "delete", index: 0 });

    expect(parseStepFields(edited)?.map((step) => step.id)).toEqual(["second"]);
  });

  it("keeps a workflow editable after the last step is removed", () => {
    const edited = editedSource(sourceOf(shell()), { type: "delete", index: 0 });

    expect(parseStepFields(edited)).toEqual([]);
    expect(parseWorkflow(edited)).toMatchObject({ ok: false, problems: [{ path: ["steps"] }] });
  });

  it.each<StepEdit>([
    { type: "delete", index: -1 },
    { type: "set", index: 2, field: "id", value: "other" },
    { type: "move", index: 0, to: 1 },
  ])("refuses an invalid step position: $type", (edit) => {
    expect(editSteps(sourceOf(shell()), edit)).toMatchObject({ ok: false });
  });

  it("refuses shell fields on an approval step", () => {
    const source = sourceOf("  - id: approve\n    type: approval\n    message: Review the code");

    expect(editSteps(source, { type: "set", index: 0, field: "run", value: "echo hello" })).toEqual(
      {
        ok: false,
        problems: ["Use the YAML editor to edit this step."],
      },
    );
  });

  it.each<StepEdit>([
    { type: "delete", index: 0 },
    { type: "move", index: 1, to: 0 },
  ])("refuses an edit that leaves an alias without an earlier anchor: $type", (edit) => {
    const source = sourceOf(shell("first", "&command echo hello"), shell("second", "*command"));

    expect(editSteps(source, edit)).toMatchObject({ ok: false });
  });

  it.each(["agent", "approval"] as const)("adds a valid %s step with a free ID", (type) => {
    const source = sourceOf(
      type === "agent" ? agent("agent_1") : approval.replace("approve", "approval_1"),
    );

    const edited = editedSource(
      source,
      type === "agent" ? { type: "add_agent", agent: "claude-code" } : { type: "add_approval" },
    );

    expect(parseStepFields(edited)?.[1]).toMatchObject({ id: `${type}_2`, type });
    expect(parseWorkflow(edited).ok).toBe(true);
  });

  it("adds a valid github step", () => {
    const edited = editedSource(sourceOf(shell()), { type: "add_github" });

    expect(parseStepFields(edited)?.[1]).toMatchObject({ id: "github_1", type: "github" });
    expect(parseWorkflow(edited).ok).toBe(true);
  });

  it("changes a github step to a pull request comment", () => {
    let source = editedSource(sourceOf(shell()), { type: "add_github" });

    source = editedSource(source, {
      type: "set",
      index: 1,
      field: "action",
      value: "comment_on_pull_request",
    });
    source = editedSource(source, { type: "set", index: 1, field: "body", value: "Ready" });

    expect(parseStepFields(source)?.[1]).toMatchObject({
      action: "comment_on_pull_request",
      body: "Ready",
    });
  });

  it("refuses on_exhausted on a loop", () => {
    const loop = editedSource(sourceOf(shell("shell_1")), { type: "add_loop" });

    expect(
      editSteps(loop, { type: "set", index: 1, field: "on_exhausted", value: "fail" }),
    ).toMatchObject({ ok: false });
  });

  it("adds a valid loop with one child and free IDs", () => {
    const edited = editedSource(sourceOf(shell("shell_1")), { type: "add_loop" });

    expect(parseStepFields(edited)?.[1]).toMatchObject({ id: "loop_1", type: "loop" });
    expect(edited).toContain("id: shell_2");
    expect(parseWorkflow(edited).ok).toBe(true);
  });

  it("refuses a loop in a loop", () => {
    const withLoop = editedSource(sourceOf(shell()), { type: "add_loop" });

    expect(editSteps(withLoop, { type: "add_loop", parent: 1 })).toMatchObject({ ok: false });
  });

  it("adds an agent step with the agent of the edit", () => {
    const edited = editedSource(sourceOf(shell()), { type: "add_agent", agent: "codex" });

    expect(parseStepFields(edited)?.[1]?.agent).toBe("codex");
  });

  it("reads agent and approval fields from YAML", () => {
    const source = sourceOf(
      `${agent()}\n    max_attempts: 3\n    gates:\n      - name: tests\n        run: pnpm test\n        on_fail: retry`,
      approval,
    );

    expect(parseStepFields(source)).toMatchObject([
      {
        agent: "claude-code",
        prompt: "Implement the task",
        max_attempts: "3",
        gates: [{ name: "tests", run: "pnpm test", on_fail: "retry" }],
      },
      { message: "Review the code" },
    ]);
  });

  it.each<{ source: string; field: StepField; value: string }>([
    { source: sourceOf(agent()), field: "agent", value: "codex" },
    { source: sourceOf(agent()), field: "model", value: "small" },
    {
      source: sourceOf(agent()),
      field: "prompt",
      value: "Implement the task\nReport the result\n",
    },
    { source: sourceOf(approval), field: "message", value: "Review the diff" },
  ])("edits $field without changing the step type", ({ source, field, value }) => {
    const edited = editedSource(source, { type: "set", index: 0, field, value });

    expect(parseStepFields(edited)?.[0]?.[field]).toBe(value);
    expect(parseWorkflow(edited).ok).toBe(true);
  });

  it("removes the model of an agent step when the field is empty", () => {
    const source = sourceOf(`${agent()}\n    model: small`);

    const edited = editedSource(source, { type: "set", index: 0, field: "model", value: "" });

    expect(edited).not.toContain("model");
  });

  it.each(["max_attempts", "max_turns", "max_reminders", "max_cost_usd"] as const)(
    "stores %s as a YAML number",
    (field) => {
      const edited = editedSource(sourceOf(agent()), { type: "set", index: 0, field, value: "2" });

      expect(parseWorkflow(edited)).toMatchObject({ ok: true, value: { steps: [{ [field]: 2 }] } });
    },
  );

  it("stores a decimal cost as a YAML number", () => {
    const edited = editedSource(sourceOf(agent()), {
      type: "set",
      index: 0,
      field: "max_cost_usd",
      value: "0.5",
    });

    expect(parseWorkflow(edited)).toMatchObject({
      ok: true,
      value: { steps: [{ max_cost_usd: 0.5 }] },
    });
  });

  it("keeps the text of a cost while the user types it", () => {
    let source = sourceOf(agent());

    for (const key of "0.05") {
      const shown = parseStepFields(source)?.[0]?.max_cost_usd ?? "";
      source = editedSource(source, {
        type: "set",
        index: 0,
        field: "max_cost_usd",
        value: `${shown}${key}`,
      });
    }

    expect(parseStepFields(source)?.[0]?.max_cost_usd).toBe("0.05");
  });

  it("shows a number as it is written in YAML", () => {
    const source = sourceOf(`${agent()}\n    max_cost_usd: 1.50`);

    expect(parseStepFields(source)?.[0]?.max_cost_usd).toBe("1.50");
  });

  it("stores a number field as a number when YAML has it as text", () => {
    const source = sourceOf(`${agent()}\n    max_turns: "2"`);

    const edited = editedSource(source, { type: "set", index: 0, field: "max_turns", value: "2" });

    expect(parseWorkflow(edited)).toMatchObject({ ok: true, value: { steps: [{ max_turns: 2 }] } });
  });

  it.each<StepEdit>([
    { type: "set", index: 1, field: "run", value: "echo hello" },
    { type: "set_gate", index: 2, gate: 0, field: "run", value: "echo hello" },
  ])("keeps an alias when the edit gives its value: $type", (edit) => {
    const source = sourceOf(
      shell("first", "&command echo hello"),
      shell("second", "*command"),
      `${agent()}\n    gates:\n      - name: tests\n        run: *command`,
    );

    expect(editedSource(source, edit)).toBe(source);
  });

  it.each<{ field: string; edit: StepEdit }>([
    { field: "on_exhausted", edit: { type: "set", index: 0, field: "on_exhausted", value: "" } },
    { field: "max_turns", edit: { type: "set", index: 0, field: "max_turns", value: "" } },
    {
      field: "on_fail",
      edit: { type: "set_gate", index: 0, gate: 0, field: "on_fail", value: "" },
    },
  ])("removes an empty optional $field that YAML already has", ({ field, edit }) => {
    const source = sourceOf(
      `${agent()}\n    on_exhausted: ""\n    max_turns: ""\n    gates:\n      - name: tests\n        run: pnpm test\n        on_fail: ""`,
    );

    expect(editedSource(source, edit)).not.toContain(`${field}:`);
  });

  it.each(["max_attempts", "max_turns", "max_reminders", "max_cost_usd", "on_exhausted"] as const)(
    "removes the optional agent field %s when it is empty",
    (field) => {
      const source = sourceOf(`${agent()}\n    ${field}: ${field === "on_exhausted" ? "fail" : 2}`);

      const edited = editedSource(source, { type: "set", index: 0, field, value: "" });

      expect(edited).not.toContain(`    ${field}:`);
      expect(parseWorkflow(edited).ok).toBe(true);
    },
  );

  it("keeps an invalid numeric value for correction", () => {
    const edited = editedSource(sourceOf(agent()), {
      type: "set",
      index: 0,
      field: "max_attempts",
      value: "many",
    });

    expect(parseStepFields(edited)?.[0]?.max_attempts).toBe("many");
    expect(parseWorkflow(edited)).toMatchObject({
      ok: false,
      problems: [{ path: ["steps", 0, "max_attempts"] }],
    });
  });

  it("preserves output declarations when a prompt changes", () => {
    const source = sourceOf(
      `${agent()}\n    outcomes: [done, blocked]\n    outputs:\n      result: string`,
    );

    const edited = editedSource(source, {
      type: "set",
      index: 0,
      field: "prompt",
      value: "Describe the result",
    });

    expect(parseWorkflow(edited)).toMatchObject({
      ok: true,
      value: { steps: [{ outcomes: ["done", "blocked"], outputs: { result: "string" } }] },
    });
  });

  it("adds gates with free names", () => {
    const source = sourceOf(`${agent()}\n    gates:\n      - name: gate_1\n        run: pnpm test`);

    const edited = editedSource(source, { type: "add_gate", index: 0 });

    expect(parseStepFields(edited)?.[0]?.gates?.map((gate) => gate.name)).toEqual([
      "gate_1",
      "gate_2",
    ]);
    expect(parseWorkflow(edited).ok).toBe(true);
  });

  it("creates a gate list when the agent has none", () => {
    const edited = editedSource(sourceOf(agent()), { type: "add_gate", index: 0 });

    expect(parseStepFields(edited)?.[0]?.gates).toEqual([
      { name: "gate_1", run: "echo hello", on_fail: "" },
    ]);
    expect(parseWorkflow(edited).ok).toBe(true);
  });

  it("preserves comments and aliases when a gate command changes", () => {
    const source = sourceOf(
      `${agent()}\n    gates:\n      - name: tests\n        run: pnpm test # required check\n        on_fail: &policy retry\n      - name: lint\n        run: pnpm lint\n        on_fail: *policy`,
    );

    const edited = editedSource(source, {
      type: "set_gate",
      index: 0,
      gate: 0,
      field: "run",
      value: "pnpm test:unit",
    });

    expect(edited).toContain("pnpm test:unit # required check");
    expect(edited).toContain("&policy retry");
    expect(edited).toContain("*policy");
    expect(parseWorkflow(edited).ok).toBe(true);
  });

  it("removes an empty gate failure policy", () => {
    const source = sourceOf(
      `${agent()}\n    gates:\n      - name: tests\n        run: pnpm test\n        on_fail: fail`,
    );

    const edited = editedSource(source, {
      type: "set_gate",
      index: 0,
      gate: 0,
      field: "on_fail",
      value: "",
    });

    expect(edited).not.toContain("on_fail:");
    expect(parseWorkflow(edited).ok).toBe(true);
  });

  it("removes only the selected gate", () => {
    const source = sourceOf(
      `${agent()}\n    gates:\n      - name: tests\n        run: pnpm test\n      - name: lint\n        run: pnpm lint`,
    );

    const edited = editedSource(source, { type: "delete_gate", index: 0, gate: 0 });

    expect(parseStepFields(edited)?.[0]?.gates?.map((gate) => gate.name)).toEqual(["lint"]);
  });

  it("reports the field path for an empty gate command", () => {
    const source = editedSource(sourceOf(agent()), { type: "add_gate", index: 0 });

    const edited = editedSource(source, {
      type: "set_gate",
      index: 0,
      gate: 0,
      field: "run",
      value: "",
    });

    expect(parseWorkflow(edited)).toMatchObject({
      ok: false,
      problems: [{ path: ["steps", 0, "gates", 0, "run"] }],
    });
  });

  const uneditableGates = (gates: string) =>
    sourceOf(
      `${agent()}\n    gates: &shared\n      - &gate\n        name: tests\n        run: pnpm test`,
      `${agent("second")}\n    gates: ${gates}`,
    );
  const uneditableGateLists = ["null", "{}", "[null]", "*shared", "[*gate]"];

  it.each(uneditableGateLists)(
    "reads no gates from a gate list the form cannot edit: %s",
    (gates) => {
      expect(parseStepFields(uneditableGates(gates))?.[1]?.gates).toBeUndefined();
    },
  );

  it.each(uneditableGateLists)("refuses to edit a gate list the form cannot edit: %s", (gates) => {
    expect(editSteps(uneditableGates(gates), { type: "add_gate", index: 1 })).toMatchObject({
      ok: false,
    });
  });

  it.each<StepEdit>([
    { type: "delete_gate", index: 0, gate: -1 },
    { type: "set_gate", index: 0, gate: 1, field: "name", value: "other" },
  ])("refuses an invalid gate position: $type", (edit) => {
    const source = editedSource(sourceOf(agent()), { type: "add_gate", index: 0 });

    expect(editSteps(source, edit)).toMatchObject({ ok: false });
  });

  it("refuses gates on a shell step", () => {
    expect(editSteps(sourceOf(shell()), { type: "add_gate", index: 0 })).toMatchObject({
      ok: false,
    });
  });

  it("refuses to remove a gate whose anchor another gate uses", () => {
    const source = sourceOf(
      `${agent()}\n    gates:\n      - name: tests\n        run: &command pnpm test\n      - name: other\n        run: *command`,
    );

    expect(editSteps(source, { type: "delete_gate", index: 0, gate: 0 })).toMatchObject({
      ok: false,
    });
  });

  it("treats an unknown step type as a YAML-only step", () => {
    const source = sourceOf("  - id: other\n    type: constructor");

    expect(editSteps(source, { type: "set", index: 0, field: "id", value: "next" })).toMatchObject({
      ok: false,
    });
  });

  it("inserts a step between two existing steps", () => {
    const edited = editedSource(sourceOf(shell("first"), shell("second")), {
      type: "add_agent",
      agent: "claude-code",
      at: 1,
    });

    expect(parseStepFields(edited)?.map((step) => step.id)).toEqual(["first", "agent_1", "second"]);
    expect(parseWorkflow(edited).ok).toBe(true);
  });

  it("edits a loop child without changing a top-level step", () => {
    const source = sourceOf(
      shell("first"),
      "  - id: repeat\n    type: loop\n    max_iterations: 2\n    until: ${{ true }}\n    steps:\n      - id: child\n        type: shell\n        run: echo child",
    );

    const edited = editedSource(source, {
      type: "set",
      parent: 1,
      index: 0,
      field: "run",
      value: "pnpm test",
    });

    expect(parseStepFields(edited)?.[0]?.run).toBe("echo hello");
    expect(parseStepFields(edited)?.[1]?.children?.[0]?.run).toBe("pnpm test");
  });

  it("inserts a step inside a loop", () => {
    const source = sourceOf(
      "  - id: repeat\n    type: loop\n    max_iterations: 2\n    until: ${{ true }}\n    steps:\n      - id: child\n        type: shell\n        run: echo child",
    );

    const edited = editedSource(source, { type: "add_approval", parent: 0, at: 1 });

    expect(parseStepFields(edited)?.[0]?.children?.map((step) => step.id)).toEqual([
      "child",
      "approval_1",
    ]);
    expect(parseWorkflow(edited).ok).toBe(true);
  });

  it("stores a loop iteration limit as a number", () => {
    const source = sourceOf(
      "  - id: repeat\n    type: loop\n    max_iterations: 2\n    until: ${{ true }}\n    steps:\n      - id: child\n        type: shell\n        run: echo child",
    );

    const edited = editedSource(source, {
      type: "set",
      index: 0,
      field: "max_iterations",
      value: "4",
    });

    expect(parseWorkflow(edited)).toMatchObject({
      ok: true,
      value: { steps: [{ max_iterations: 4 }] },
    });
  });

  it("refuses a parent that is not a loop", () => {
    expect(editSteps(sourceOf(shell()), { type: "add_shell", parent: 0 })).toMatchObject({
      ok: false,
    });
  });

  it("refuses to edit a loop whose child list is not a list of maps", () => {
    const source = sourceOf(
      "  - id: repeat\n    type: loop\n    max_iterations: 2\n    until: ${{ true }}\n    steps: [null]",
    );

    expect(editSteps(source, { type: "add_shell", parent: 0 })).toEqual({
      ok: false,
      problems: ["Use the YAML editor to correct the child steps."],
    });
  });

  it.each([-1, 2, 0.5])("refuses insertion at position %s", (at) => {
    expect(editSteps(sourceOf(shell()), { type: "add_shell", at })).toMatchObject({ ok: false });
  });
});
