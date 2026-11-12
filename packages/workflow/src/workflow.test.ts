import { describe, expect, it } from "vitest";

import { schemaVersion } from "./schemaVersion";
import { parseWorkflow } from "./workflow";

// At the end, so the problem lines match the test lines.
const sourceOf = (lines: string[]) => [...lines, `schema_version: ${schemaVersion}`].join("\n");

const parse = (lines: string[]) => parseWorkflow(sourceOf(lines));

const problemsOfSource = (source: string) => {
  const result = parseWorkflow(source);
  if (result.ok) throw new Error("Expected problems");
  return result.problems;
};

const rangedProblemsOf = (lines: string[]) => problemsOfSource(sourceOf(lines));

const problemsOf = (lines: string[]) =>
  rangedProblemsOf(lines).map(({ line, column, path, message }) => ({
    line,
    column,
    path,
    message,
  }));

const rangeOf = (lines: string[]) =>
  rangedProblemsOf(lines).map(({ line, column, endLine, endColumn }) => ({
    line,
    column,
    endLine,
    endColumn,
  }));

const shellStep = ["  - id: build", "    type: shell", "    run: ls"];
const agentStep = [
  "  - id: implement",
  "    type: agent",
  "    agent: claude-code",
  "    prompt: Fix",
];

describe("parseWorkflow", () => {
  const withComment = (...fields: string[]) => [
    "name: Review",
    "on: { pull_request: { types: [opened] } }",
    "steps:",
    "  - id: report",
    "    type: github",
    ...fields,
  ];

  it("accepts a body", () => {
    const lines = withComment("    action: comment_on_pull_request", "    body: Done");

    expect(parse(lines).ok).toBe(true);
  });

  it("refuses a comment with no body", () => {
    const lines = withComment("    action: comment_on_pull_request");

    expect(problemsOf(lines)).toMatchObject([{ path: ["steps", 0, "body"] }]);
  });

  const withPullRequest = (...fields: string[]) => [
    "name: Fix",
    "inputs:",
    "  issue_number: { type: number, required: true }",
    "  issue_title: { type: string, default: '' }",
    "steps:",
    "  - id: open",
    "    type: github",
    "    action: open_pull_request",
    ...fields,
  ];

  it("accepts the text fields on open_pull_request", () => {
    const lines = withPullRequest(
      '    title: "${{ inputs.issue_title }}"',
      "    body: Done",
      '    closes: "${{ inputs.issue_number }}"',
    );

    expect(parse(lines).ok).toBe(true);
  });

  it("refuses text around the issue to close", () => {
    const lines = withPullRequest('    closes: "#${{ inputs.issue_number }}"');

    expect(problemsOf(lines)).toMatchObject([{ path: ["steps", 0, "closes"] }]);
  });

  it("refuses an issue to close that is not a number", () => {
    const lines = withPullRequest('    closes: "${{ inputs.issue_title }}"');

    expect(problemsOf(lines)).toMatchObject([
      { path: ["steps", 0, "closes"], message: "Give a number to this field" },
    ]);
  });

  it("refuses closes on a comment", () => {
    const lines = withComment(
      "    action: comment_on_pull_request",
      "    body: Done",
      '    closes: "${{ 1 }}"',
    );

    expect(problemsOf(lines)).toMatchObject([{ path: ["steps", 0, "closes"] }]);
  });

  it("refuses a title on a comment", () => {
    const lines = withComment(
      "    action: comment_on_pull_request",
      "    title: Review",
      "    body: Done",
    );

    expect(problemsOf(lines)).toMatchObject([{ path: ["steps", 0, "title"] }]);
  });

  it("refuses a comment in a workflow with no on.pull_request", () => {
    const lines = [
      "name: Review",
      "steps:",
      "  - { id: report, type: github, action: comment_on_pull_request, body: Done }",
    ];

    expect(problemsOf(lines)).toMatchObject([{ path: ["steps"] }]);
  });

  it("refuses an unknown name in the body", () => {
    const lines = withComment(
      "    action: comment_on_pull_request",
      '    body: "${{ steps.nothing.summary }}"',
    );

    expect(problemsOf(lines)).toMatchObject([{ path: ["steps", 0, "body"] }]);
  });

  const onPullRequest = (types: string, ...fields: string[]) => [
    "name: Review",
    "on:",
    "  pull_request:",
    `    types: [${types}]`,
    ...fields,
    "steps:",
    ...shellStep,
  ];

  it("accepts an action with no concurrency", () => {
    expect(parse(onPullRequest("opened")).ok).toBe(true);
  });

  it("refuses synchronize with no cancel_in_progress", () => {
    expect(problemsOf(onPullRequest("synchronize"))).toMatchObject([
      { path: ["on", "pull_request", "types"] },
    ]);
  });

  it("accepts synchronize with cancel_in_progress", () => {
    const fields = ["concurrency: { group: review, cancel_in_progress: true }"];

    expect(parse(onPullRequest("synchronize", ...fields)).ok).toBe(true);
  });

  it("refuses open_pull_request", () => {
    const lines = [
      "name: Review",
      "on:",
      "  pull_request:",
      "    types: [opened]",
      "steps:",
      "  - { id: open, type: github, action: open_pull_request }",
    ];

    expect(problemsOf(lines)).toMatchObject([{ path: ["on", "pull_request"] }]);
  });

  const withConcurrency = (...fields: string[]) => ["name: Fix", ...fields, "steps:", ...shellStep];

  it("refuses cancel_in_progress with a branch name", () => {
    const lines = withConcurrency(
      "branch: { name: fix }",
      "concurrency: { group: fix, cancel_in_progress: true }",
    );

    expect(problemsOf(lines)).toMatchObject([{ path: ["concurrency", "cancel_in_progress"] }]);
  });

  it("accepts a group with a branch name when it cancels nothing", () => {
    const lines = withConcurrency(
      "branch: { name: fix }",
      "concurrency: { group: fix, cancel_in_progress: false }",
    );

    expect(parse(lines).ok).toBe(true);
  });

  it.each([
    ["a step", "${{ steps.build.summary }}", 'Unknown name "steps". Use inputs'],
    ["an unknown input", "${{ inputs.env }}", 'The workflow has no input "env"'],
  ])("refuses %s in the name of a group", (_, group, message) => {
    const lines = withConcurrency(`concurrency: { group: "${group}" }`);

    expect(problemsOf(lines)).toMatchObject([{ path: ["concurrency", "group"], message }]);
  });

  it("gives a problem of a value the range from its key to the end of its value", () => {
    expect(rangeOf(["name: Fix", "steps:", ...agentStep, "    max_reminders: 1.5"])).toEqual([
      { line: 7, column: 5, endLine: 7, endColumn: 23 },
    ]);
  });

  it("gives a problem of a multi-line value a range over all its lines", () => {
    const lines = ["name: Fix", "steps:", ...agentStep, "    outputs:", "      - a", "      - b"];

    expect(problemsOfSource(["schema_version: 1", ...lines].join("\n"))).toMatchObject([
      { line: 8, column: 5, endLine: 10, endColumn: 10 },
    ]);
  });

  it("gives a problem of a missing key the first line of its parent", () => {
    const lines = ["name: Fix", "steps:", "  - id: fix", "    type: shell", "    timeout: 1m"];

    expect(rangeOf(lines)).toEqual([{ line: 3, column: 5, endLine: 3, endColumn: 12 }]);
  });

  it("gives a YAML problem the range of the error", () => {
    const lines = ["name: Build", "name: Test", "steps: []"];

    expect(rangeOf(lines)).toEqual([{ line: 2, column: 1, endLine: 2, endColumn: 2 }]);
  });

  it("parses a shell step with its script as written", () => {
    const lines = [
      "name: Build",
      "steps:",
      "  - id: build",
      "    type: shell",
      "    run: |",
      "      pnpm build",
      "",
    ];
    expect(parse(lines)).toEqual({
      ok: true,
      value: {
        name: "Build",
        steps: [{ id: "build", type: "shell", run: "pnpm build\n" }],
      },
    });
  });

  it("parses agent steps", () => {
    const lines = [
      "name: Fix",
      "steps:",
      "  - id: implement",
      "    type: agent",
      "    agent: claude-code",
      "    prompt: Fix the bug",
    ];
    expect(parse(lines)).toEqual({
      ok: true,
      value: {
        name: "Fix",
        steps: [{ id: "implement", type: "agent", agent: "claude-code", prompt: "Fix the bug" }],
      },
    });
  });

  it("parses approval steps", () => {
    const lines = [
      "name: Ship",
      "steps:",
      "  - id: approve",
      "    type: approval",
      "    message: Check the diff",
    ];
    expect(parse(lines)).toEqual({
      ok: true,
      value: {
        name: "Ship",
        steps: [{ id: "approve", type: "approval", message: "Check the diff" }],
      },
    });
  });

  it("parses max_reminders of an agent step", () => {
    const result = parse(["name: Fix", "steps:", ...agentStep, "    max_reminders: 0"]);

    expect(result).toMatchObject({ ok: true, value: { steps: [{ max_reminders: 0 }] } });
  });

  it("refuses a max_reminders that is not a whole number", () => {
    const problems = problemsOf(["name: Fix", "steps:", ...agentStep, "    max_reminders: 1.5"]);

    expect(problems).toEqual([
      { line: 7, column: 5, path: ["steps", 0, "max_reminders"], message: "Use a whole number" },
    ]);
  });

  it("refuses a negative max_reminders", () => {
    const problems = problemsOf(["name: Fix", "steps:", ...agentStep, "    max_reminders: -1"]);

    expect(problems).toEqual([
      { line: 7, column: 5, path: ["steps", 0, "max_reminders"], message: "Use 0 or more" },
    ]);
  });

  it("refuses a max_attempts less than 1", () => {
    const problems = problemsOf(["name: Fix", "steps:", ...agentStep, "    max_attempts: 0"]);

    expect(problems).toEqual([
      { line: 7, column: 5, path: ["steps", 0, "max_attempts"], message: "Use 1 or more" },
    ]);
  });

  it("parses the gates of an agent step as written", () => {
    const gates = [
      "    gates:",
      "      - name: lint",
      "        run: pnpm lint",
      "      - name: tests",
      "        run: pnpm test",
      "        on_fail: fail",
      "      - name: e2e",
      "        run: pnpm e2e",
      "        on_fail: ask_human",
    ];

    expect(parse(["name: Fix", "steps:", ...agentStep, ...gates])).toMatchObject({
      ok: true,
      value: {
        steps: [
          {
            gates: [
              { name: "lint", run: "pnpm lint" },
              { name: "tests", run: "pnpm test", on_fail: "fail" },
              { name: "e2e", run: "pnpm e2e", on_fail: "ask_human" },
            ],
          },
        ],
      },
    });
  });

  it("refuses a gate on_fail that is not retry, ask_human or fail", () => {
    const gate = [
      "    gates:",
      "      - name: tests",
      "        run: pnpm test",
      "        on_fail: ask",
    ];

    expect(problemsOf(["name: Fix", "steps:", ...agentStep, ...gate])).toMatchObject([
      { line: 10, path: ["steps", 0, "gates", 0, "on_fail"] },
    ]);
  });

  const shellWith = (network: string) => [
    "  - id: build",
    "    type: shell",
    "    run: make",
    `    network: ${network}`,
  ];

  const gateWith = (network: string) => [
    "    gates:",
    "      - name: tests",
    "        run: make test",
    `        network: ${network}`,
  ];

  it("reads the network of a shell step", () => {
    expect(parse(["name: Fix", "steps:", ...shellWith("true")])).toMatchObject({
      ok: true,
      value: { steps: [{ network: true }] },
    });
  });

  it("reads the network of a gate", () => {
    const gate = gateWith("[registry.npmjs.org]");

    expect(parse(["name: Fix", "steps:", ...agentStep, ...gate])).toMatchObject({
      ok: true,
      value: { steps: [{ gates: [{ network: ["registry.npmjs.org"] }] }] },
    });
  });

  it("refuses a host of a shell step that is not a host name", () => {
    expect(problemsOf(["name: Fix", "steps:", ...shellWith("[Example.com]")])).toMatchObject([
      { path: ["steps", 0, "network", 0] },
    ]);
  });

  it("refuses a host of a gate that is not a host name", () => {
    const gate = gateWith("[Example.com]");

    expect(problemsOf(["name: Fix", "steps:", ...agentStep, ...gate])).toMatchObject([
      { path: ["steps", 0, "gates", 0, "network", 0] },
    ]);
  });

  it("parses the on_exhausted of an agent step", () => {
    expect(parse(["name: Fix", "steps:", ...agentStep, "    on_exhausted: fail"])).toMatchObject({
      ok: true,
      value: { steps: [{ on_exhausted: "fail" }] },
    });
  });

  it("refuses an on_exhausted that is not ask_human or fail", () => {
    const problems = problemsOf(["name: Fix", "steps:", ...agentStep, "    on_exhausted: retry"]);

    expect(problems).toMatchObject([{ line: 7, path: ["steps", 0, "on_exhausted"] }]);
  });

  it("parses the limits of an agent step", () => {
    const fields = ["    max_turns: 200", "    timeout: 45m", "    max_cost_usd: 2.5"];

    expect(parse(["name: Fix", "steps:", ...agentStep, ...fields])).toMatchObject({
      ok: true,
      value: { steps: [{ max_turns: 200, timeout: "45m", max_cost_usd: 2.5 }] },
    });
  });

  it("refuses a timeout that is not a duration", () => {
    const problems = problemsOf(["name: Fix", "steps:", ...agentStep, "    timeout: 45"]);

    expect(problems).toMatchObject([{ path: ["steps", 0, "timeout"] }]);
  });

  it("refuses a max_turns of 0", () => {
    const problems = problemsOf(["name: Fix", "steps:", ...agentStep, "    max_turns: 0"]);

    expect(problems).toMatchObject([{ path: ["steps", 0, "max_turns"], message: "Use 1 or more" }]);
  });

  it("parses the timeout of a shell step", () => {
    const step = ["  - id: lint", "    type: shell", "    run: pnpm lint", "    timeout: 10m"];

    expect(parse(["name: Fix", "steps:", ...step])).toMatchObject({
      ok: true,
      value: { steps: [{ timeout: "10m" }] },
    });
  });

  it("refuses a max_cost_usd of 0", () => {
    const problems = problemsOf(["name: Fix", "steps:", ...agentStep, "    max_cost_usd: 0"]);

    expect(problems).toMatchObject([{ path: ["steps", 0, "max_cost_usd"] }]);
  });

  it("parses the permissions and require_changes of an agent step", () => {
    const fields = ["    permissions:", "      write: true", "    require_changes: false"];

    expect(parse(["name: Fix", "steps:", ...agentStep, ...fields])).toMatchObject({
      ok: true,
      value: { steps: [{ permissions: { write: true }, require_changes: false }] },
    });
  });

  it("parses the shell and network permissions of an agent step", () => {
    const fields = [
      "    permissions:",
      "      shell: false",
      "      network: [registry.npmjs.org]",
    ];

    expect(parse(["name: Fix", "steps:", ...agentStep, ...fields])).toMatchObject({
      ok: true,
      value: { steps: [{ permissions: { shell: false, network: ["registry.npmjs.org"] } }] },
    });
  });

  it("refuses an unknown permission", () => {
    const fields = ["    permissions:", "      browser: false"];

    expect(problemsOf(["name: Fix", "steps:", ...agentStep, ...fields])).toMatchObject([
      { path: ["steps", 0, "permissions", "browser"] },
    ]);
  });

  it("refuses a network host that is not a host name", () => {
    const fields = ["    permissions:", "      network: [https://example.com]"];

    expect(problemsOf(["name: Fix", "steps:", ...agentStep, ...fields])).toMatchObject([
      { path: ["steps", 0, "permissions", "network", 0] },
    ]);
  });

  it.each([true, false])("refuses require_changes %s with write false", (value) => {
    const fields = ["    permissions:", "      write: false", `    require_changes: ${value}`];

    expect(problemsOf(["name: Fix", "steps:", ...agentStep, ...fields])).toMatchObject([
      {
        line: 9,
        path: ["steps", 0, "require_changes"],
        message: "Do not use require_changes with write: false",
      },
    ]);
  });

  it("refuses ${{ }} in the run of a gate", () => {
    const gate = ["    gates:", "      - name: tests", "        run: echo ${{ steps.a.summary }}"];

    expect(problemsOf(["name: Fix", "steps:", ...agentStep, ...gate])).toEqual([
      {
        line: 9,
        column: 9,
        path: ["steps", 0, "gates", 0, "run"],
        message: "Do not use ${{ }} in run",
      },
    ]);
  });

  it("reports a repeated gate name at the repeat", () => {
    const gates = [
      "    gates:",
      "      - name: tests",
      "        run: pnpm test",
      "      - name: tests",
      "        run: pnpm e2e",
    ];

    expect(problemsOf(["name: Fix", "steps:", ...agentStep, ...gates])).toEqual([
      {
        line: 10,
        column: 9,
        path: ["steps", 0, "gates", 1, "name"],
        message: 'The gate name "tests" is already used',
      },
    ]);
  });

  it("parses outcomes as a list", () => {
    const result = parse(["name: Fix", "steps:", ...agentStep, "    outcomes: [approve, reject]"]);

    expect(result).toMatchObject({
      ok: true,
      value: { steps: [{ outcomes: ["approve", "reject"] }] },
    });
  });

  it("parses outcomes as a map to ok or fail", () => {
    const result = parse([
      "name: Fix",
      "steps:",
      ...agentStep,
      "    outcomes: { done: ok, blocked: fail }",
    ]);

    expect(result).toMatchObject({
      ok: true,
      value: { steps: [{ outcomes: { done: "ok", blocked: "fail" } }] },
    });
  });

  it("reports an invalid outcome name at its position", () => {
    const list = problemsOf([
      "name: Fix",
      "steps:",
      ...agentStep,
      "    outcomes: [approve, Reject]",
    ]);
    const map = problemsOf(["name: Fix", "steps:", ...agentStep, "    outcomes: { Done: ok }"]);

    expect(list).toEqual([
      {
        line: 7,
        column: 25,
        path: ["steps", 0, "outcomes", 1],
        message: "Start with a letter. Use only lowercase letters, digits and underscores",
      },
    ]);
    expect(map).toEqual([
      {
        line: 7,
        column: 17,
        path: ["steps", 0, "outcomes", "Done"],
        message: "Start with a letter. Use only lowercase letters, digits and underscores",
      },
    ]);
  });

  it("reports a repeated outcome at the repeat", () => {
    const problems = problemsOf([
      "name: Fix",
      "steps:",
      ...agentStep,
      "    outcomes: [approve, reject, approve]",
    ]);

    expect(problems).toEqual([
      {
        line: 7,
        column: 33,
        path: ["steps", 0, "outcomes", 2],
        message: 'The outcome "approve" is already used',
      },
    ]);
  });

  it("refuses an outcome that is not text", () => {
    const problems = problemsOf([
      "name: Fix",
      "steps:",
      ...agentStep,
      "    outcomes: [approve, 1]",
    ]);

    expect(problems).toEqual([
      { line: 7, column: 25, path: ["steps", 0, "outcomes", 1], message: "Use a string" },
    ]);
  });

  it("refuses an outcome result other than ok or fail", () => {
    const problems = problemsOf([
      "name: Fix",
      "steps:",
      ...agentStep,
      "    outcomes:",
      "      done: ok",
      "      blocked: stop",
    ]);

    expect(problems).toEqual([
      { line: 9, column: 7, path: ["steps", 0, "outcomes", "blocked"], message: "Use ok or fail" },
    ]);
  });

  it("refuses empty outcomes", () => {
    const list = problemsOf(["name: Fix", "steps:", ...agentStep, "    outcomes: []"]);
    const map = problemsOf(["name: Fix", "steps:", ...agentStep, "    outcomes: {}"]);

    expect(list.map((problem) => problem.message)).toEqual(["Add at least one outcome"]);
    expect(map.map((problem) => problem.message)).toEqual(["Add at least one outcome"]);
  });

  it("reports outcomes and outputs without a value as required", () => {
    const problems = problemsOf([
      "name: Fix",
      "steps:",
      ...agentStep,
      "    outcomes:",
      "    outputs:",
    ]);

    expect(problems.map((problem) => problem.message)).toEqual(["Required", "Required"]);
  });

  it("refuses outcomes that are not a list or a map", () => {
    const problems = problemsOf(["name: Fix", "steps:", ...agentStep, "    outcomes: done"]);

    expect(problems.map((problem) => problem.message)).toEqual([
      "Use a list of outcomes or a map with ok or fail values",
    ]);
  });

  it("parses nested output types", () => {
    const result = parse([
      "name: Review",
      "steps:",
      ...agentStep,
      "    outputs:",
      "      approved: boolean",
      "      findings: { type: array, items: { file: string, line: number } }",
    ]);

    expect(result).toMatchObject({
      ok: true,
      value: {
        steps: [
          {
            outputs: {
              approved: "boolean",
              findings: { type: "array", items: { file: "string", line: "number" } },
            },
          },
        ],
      },
    });
  });

  it("reports an unknown output type in a nested map at its position", () => {
    const problems = problemsOf([
      "name: Review",
      "steps:",
      ...agentStep,
      "    outputs:",
      "      findings: { type: array, items: { file: text } }",
    ]);

    expect(problems).toEqual([
      {
        line: 8,
        column: 41,
        path: ["steps", 0, "outputs", "findings", "items", "file"],
        message: "Use string, number, boolean, a map of fields or { type: array, items }",
      },
    ]);
  });

  it("refuses an invalid output name", () => {
    const problems = problemsOf([
      "name: Fix",
      "steps:",
      ...agentStep,
      "    outputs: { Body: string }",
    ]);

    expect(problems.map((problem) => problem.message)).toEqual([
      "Start with a letter. Use only lowercase letters, digits and underscores",
    ]);
  });

  it("refuses an array type without items", () => {
    const problems = problemsOf([
      "name: Fix",
      "steps:",
      ...agentStep,
      "    outputs: { findings: { type: array, item: string } }",
    ]);

    expect(problems).toEqual([
      {
        line: 7,
        column: 16,
        path: ["steps", 0, "outputs", "findings", "items"],
        message: "Required",
      },
      {
        line: 7,
        column: 41,
        path: ["steps", 0, "outputs", "findings", "item"],
        message: "Unknown key",
      },
    ]);
  });

  it("refuses an empty map of fields", () => {
    const problems = problemsOf(["name: Fix", "steps:", ...agentStep, "    outputs: { meta: {} }"]);

    expect(problems.map((problem) => problem.message)).toEqual(["Add at least one field"]);
  });

  it("reports an output without a type as required", () => {
    const problems = problemsOf([
      "name: Fix",
      "steps:",
      ...agentStep,
      "    outputs:",
      "      title:",
    ]);

    expect(problems).toEqual([
      { line: 8, column: 7, path: ["steps", 0, "outputs", "title"], message: "Required" },
    ]);
  });

  it("refuses outputs that are not a map", () => {
    const problems = problemsOf(["name: Fix", "steps:", ...agentStep, "    outputs: [title]"]);

    expect(problems).toEqual([
      { line: 7, column: 5, path: ["steps", 0, "outputs"], message: "Use a map" },
    ]);
  });

  it.each(["commit", "reviewed_commit"])(
    "refuses the output name %s, which Halinka gives",
    (name) => {
      const problems = problemsOf([
        "name: Fix",
        "steps:",
        ...agentStep,
        `    outputs: { ${name}: string }`,
      ]);

      expect(problems).toMatchObject([
        {
          path: ["steps", 0, "outputs", name],
          message: `Use another name: Halinka gives the output "${name}"`,
        },
      ]);
    },
  );

  const withInputs = (inputs: string[], ...steps: string[]) => [
    "name: Fix",
    "inputs:",
    ...inputs,
    "steps:",
    ...steps,
  ];
  const issueInput = ["  issue: { type: number, required: true }"];

  it("parses inputs as written", () => {
    const result = parse(
      withInputs(
        [...issueInput, "  title: { default: Fix, description: The PR title }"],
        ...shellStep,
      ),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        inputs: {
          issue: { type: "number", required: true },
          title: { default: "Fix", description: "The PR title" },
        },
      },
    });
  });

  it.each([
    ["{ type: number, default: '12' }", "Use a number"],
    ["{ default: true }", "Use text"],
    ["{ type: boolean, default: 1 }", "Use true or false"],
  ])("refuses the default of %s", (input, message) => {
    const problems = problemsOf(withInputs([`  issue: ${input}`], ...shellStep));

    expect(problems).toMatchObject([{ line: 3, path: ["inputs", "issue", "default"], message }]);
  });

  it("refuses an input that is required and has a default", () => {
    const problems = problemsOf(
      withInputs(["  issue: { required: true, default: x }"], ...shellStep),
    );

    expect(problems).toMatchObject([
      { path: ["inputs", "issue", "required"], message: "Remove required or default" },
    ]);
  });

  it("refuses an input name that is not an identifier", () => {
    const problems = problemsOf(withInputs(["  Issue: {}"], ...shellStep));

    expect(problems.map(({ path }) => path)).toEqual([["inputs", "Issue"]]);
  });

  it("accepts a declared input in a prompt and a condition", () => {
    const result = parse(
      withInputs(
        issueInput,
        ...agentStep.slice(0, 3),
        ['    prompt: "Fix #${{ inputs.issue }}"', '    if: "${{ inputs.issue != 0 }}"'].join("\n"),
      ),
    );

    expect(result.ok).toBe(true);
  });

  it("accepts an optional input without a default only before ??", () => {
    const lines = (expression: string) =>
      withInputs(["  note: {}"], ...agentStep.slice(0, 3), `    prompt: "${expression}"`);

    expect(parse(lines("${{ inputs.note ?? inputs.note ?? '' }}")).ok).toBe(true);
    expect(
      problemsOf(lines("${{ inputs.note ?? inputs.note }}")).map(({ message }) => message),
    ).toEqual(['The input "note" can have no value. Add a default with ??']);
  });

  it.each([
    ["${{ inputs }}", "Use inputs.<name>"],
    ["${{ inputs.issue.id }}", '"inputs.issue" is a number. Remove the rest of the path'],
    ["${{ inputs.title.length }}", '"inputs.title" is a string. Remove the rest of the path'],
  ])("refuses the reference %s", (expression, message) => {
    const problems = problemsOf(
      withInputs(
        [...issueInput, "  title: { default: Fix }"],
        ...agentStep.slice(0, 3),
        `    prompt: "${expression}"`,
      ),
    );

    expect(problems.map((problem) => problem.message)).toEqual([message]);
  });

  it("checks the references when another field has a problem", () => {
    const problems = problemsOf([
      "name: ' '",
      "steps:",
      ...agentStep.slice(0, 3),
      '    prompt: "${{ inputs.issue }}"',
    ]);

    expect(problems.map(({ message }) => message)).toEqual([
      "Must not be empty",
      'The workflow has no input "issue"',
    ]);
  });

  it("checks the references when a step id is repeated", () => {
    const problems = problemsOf([
      "name: Fix",
      "steps:",
      ...shellStep,
      ...shellStep,
      ...agentStep.slice(0, 3),
      '    prompt: "${{ inputs.issue }}"',
    ]);

    expect(problems.map(({ message }) => message)).toEqual([
      'The step id "build" is already used',
      'The workflow has no input "issue"',
    ]);
  });

  it("checks the references when the workflow has an unknown key", () => {
    const problems = problemsOf([
      "name: Fix",
      "trigger: {}",
      "steps:",
      ...agentStep.slice(0, 3),
      '    prompt: "${{ inputs.issue }}"',
    ]);

    expect(problems.map(({ message }) => message)).toEqual([
      "Unknown key",
      'The workflow has no input "issue"',
    ]);
  });

  it("does not check the references when the inputs have a problem", () => {
    const problems = problemsOf(
      withInputs(
        ["  issue: { type: date }"],
        ...agentStep.slice(0, 3),
        '    prompt: "${{ inputs.issue }}"',
      ),
    );

    expect(problems.map(({ path }) => path)).toEqual([["inputs", "issue", "type"]]);
  });

  const withBranch = (name: string) => [
    "name: Fix",
    "inputs:",
    "  issue: { type: number, required: true }",
    "  note: {}",
    "branch:",
    `  name: "${name}"`,
    "steps:",
    ...shellStep,
  ];
  const messagesOf = (name: string) => problemsOf(withBranch(name)).map(({ message }) => message);

  it("parses a branch name that reads the inputs", () => {
    expect(parse(withBranch("halinka/issue-${{ inputs.issue }}"))).toMatchObject({
      ok: true,
      value: { branch: { name: "halinka/issue-${{ inputs.issue }}" } },
    });
  });

  it.each([
    ["${{ steps.build.summary }}", 'Unknown name "steps". Use inputs'],
    ["${{ inputs.note }}", 'The input "note" can have no value. Add a default with ??'],
  ])("refuses %s in the branch name", (name, message) => {
    expect(problemsOf(withBranch(name))).toEqual([
      { line: 6, column: 3, path: ["branch", "name"], message },
    ]);
  });

  it.each(["fix it", "fix it/${{ inputs.issue }}"])("refuses the branch name %j", (name) => {
    expect(messagesOf(name)).toEqual([
      "Use a git branch name: no spaces, .., @{, //, ~ ^ : ? * [ \\, and no / or . at the start or end",
    ]);
  });

  it("accepts a branch name that git accepts", () => {
    expect(parse(withBranch("halinka/fix-1.2")).ok).toBe(true);
  });

  const withLabels = (labels: string) => [
    "name: Build",
    `runs-on: ${labels}`,
    "steps:",
    ...shellStep,
  ];

  it("parses the labels of the runner", () => {
    expect(parse(withLabels("[gpu, linux-arm64]"))).toMatchObject({
      ok: true,
      value: { "runs-on": ["gpu", "linux-arm64"] },
    });
  });

  it("refuses a label with an uppercase letter", () => {
    expect(problemsOf(withLabels("[GPU]")).map(({ path }) => path)).toEqual([["runs-on", 0]]);
  });

  const review = [
    "  - id: review",
    "    type: agent",
    "    agent: codex",
    "    prompt: Review",
    "    outcomes: [approve, changes_requested]",
    "    outputs: { findings: string }",
  ];
  const withStep = (...lines: string[]) => ["name: Fix", "steps:", ...review, ...lines];
  const fixStep = (prompt: string, condition?: string) => [
    "  - id: fix",
    "    type: agent",
    "    agent: claude-code",
    `    prompt: "${prompt}"`,
    ...(condition ? [`    if: "${condition}"`] : []),
  ];

  it("parses an if condition that reads an earlier step", () => {
    const result = parse(
      withStep(
        ...fixStep(
          "Fix ${{ steps.review.outputs.findings }}",
          "${{ steps.review.outcome == 'changes_requested' }}",
        ),
      ),
    );

    expect(result).toMatchObject({
      ok: true,
      value: { steps: [{}, { if: "${{ steps.review.outcome == 'changes_requested' }}" }] },
    });
  });

  it("refuses an if condition that is not one ${{ }}", () => {
    const problems = problemsOf(withStep(...fixStep("Fix", "steps.review.outcome == 'approve'")));

    expect(problems).toEqual([
      {
        line: 13,
        column: 5,
        path: ["steps", 1, "if"],
        message: "Write the condition as ${{ ... }}",
      },
    ]);
  });

  it("reports a syntax problem of an expression at its field", () => {
    const problems = problemsOf(withStep(...fixStep("Fix ${{ steps.review.summary == }}")));

    expect(problems).toEqual([
      {
        line: 12,
        column: 5,
        path: ["steps", 1, "prompt"],
        message: "Complete the expression: steps.review.summary ==",
      },
    ]);
  });

  it("refuses a ${{ without }}", () => {
    const problems = problemsOf(withStep(...fixStep("Fix ${{ steps.review.summary")));

    expect(problems.map((problem) => problem.message)).toEqual(["Close each ${{ with }}"]);
  });

  it("refuses an expression in a shell run", () => {
    const problems = problemsOf(
      withStep(...shellStep.slice(0, 2), "    run: echo ${{ steps.review.summary }}"),
    );

    expect(problems.map((problem) => problem.message)).toEqual(["Do not use ${{ }} in run"]);
  });

  it.each([
    ["${{ issue.number }}", 'Unknown name "issue". Use inputs, steps'],
    ["${{ inputs.issue }}", 'The workflow has no input "issue"'],
    ["${{ steps }}", "Use steps.<step id>.<field>"],
    ["${{ steps.fix.summary }}", 'The step "fix" does not run before this step'],
    ["${{ steps.deploy.summary }}", 'The step "deploy" does not run before this step'],
    ["${{ steps.review.cost }}", "Use a field of the step: status, outcome, summary, outputs"],
    ["${{ steps.review.outputs.title }}", 'The step "review" has no output "title"'],
    [
      "${{ steps.review.outputs.reviewed_commit }}",
      'The step "review" has no output "reviewed_commit"',
    ],
    ["${{ steps.build.outcome }}", 'The step "build" has no outcomes'],
    ["${{ steps.build.outputs }}", 'The step "build" has no outputs'],
    [
      "${{ steps.build.summary.length }}",
      '"steps.build.summary" is a string. Remove the rest of the path',
    ],
    [
      "${{ steps.review.outputs.findings.file }}",
      '"steps.review.outputs.findings" is a string. Remove the rest of the path',
    ],
  ])("refuses the reference %s", (expression, message) => {
    const problems = problemsOf(withStep(...shellStep, ...fixStep(`Fix ${expression}`)));

    expect(problems).toEqual([{ line: 15, column: 5, path: ["steps", 2, "prompt"], message }]);
  });

  it("reads the URL that a github step gives", () => {
    const github = ["  - { id: publish, type: github, action: open_pull_request }"];

    expect(
      parse(withStep(...github, ...fixStep("${{ steps.publish.outputs.pull_request_url }}"))).ok,
    ).toBe(true);
  });

  it("refuses another output of a github step", () => {
    const github = ["  - { id: publish, type: github, action: open_pull_request }"];

    expect(
      problemsOf(withStep(...github, ...fixStep("${{ steps.publish.outputs.title }}"))),
    ).toMatchObject([{ message: 'The step "publish" has no output "title"' }]);
  });

  it("reads the outputs that Halinka gives each agent step", () => {
    const prompt =
      "${{ steps.review.outputs.changed_files[0] }} ${{ steps.review.outputs.commit }} " +
      "${{ steps.review.outputs.session_id }} ${{ steps.review.outputs.cost_usd }}";

    expect(parse(withStep(...fixStep(prompt))).ok).toBe(true);
  });

  it("gives reviewed_commit to an agent step with write: false", () => {
    const result = parse(
      withStep(
        "    permissions: { write: false }",
        ...fixStep("Fix ${{ steps.review.outputs.reviewed_commit }}"),
      ),
    );

    expect(result.ok).toBe(true);
  });

  it("refuses a comparison with an outcome that the step does not declare", () => {
    const problems = problemsOf(
      withStep(...fixStep("Fix", "${{ steps.review.outcome == 'reject' }}")),
    );

    expect(problems).toEqual([
      {
        line: 13,
        column: 5,
        path: ["steps", 1, "if"],
        message: 'The step "review" has no outcome "reject"',
      },
    ]);
  });

  it("checks a nested output path against the declared types", () => {
    const nested = [
      "  - id: scan",
      "    type: agent",
      "    agent: codex",
      "    prompt: Scan",
      "    outputs: { issues: { type: array, items: { file: string } } }",
    ];

    const problems = problemsOf(
      withStep(
        ...nested,
        ...fixStep(
          "${{ steps.scan.outputs.issues[0].file }} ${{ steps.scan.outputs.issues.file }} ${{ steps.scan.outputs.issues[0].line }}",
        ),
      ),
    );

    expect(problems.map((problem) => problem.message)).toEqual([
      '"steps.scan.outputs.issues" is a list. Read an item with [number]',
      '"steps.scan.outputs.issues[0]" has no field "line"',
    ]);
  });

  it("accepts an outcome that one step of a ?? chain declares", () => {
    const approval = ["  - id: approve", "    type: approval", "    message: Check"];

    const result = parse(
      withStep(
        ...approval,
        ...fixStep("Fix", "${{ (steps.review.outcome ?? steps.approve.outcome) == 'approved' }}"),
      ),
    );

    expect(result.ok).toBe(true);
  });

  it("refuses an outcome that no step of a ?? chain declares", () => {
    const approval = ["  - id: approve", "    type: approval", "    message: Check"];

    const problems = problemsOf(
      withStep(
        ...approval,
        ...fixStep("Fix", "${{ (steps.review.outcome ?? steps.approve.outcome) == 'done' }}"),
      ),
    );

    expect(problems.map((problem) => problem.message)).toEqual([
      'None of the steps "review", "approve" has the outcome "done"',
    ]);
  });

  it("refuses a default of ?? that is not an outcome of the step", () => {
    const problems = problemsOf(
      withStep(...fixStep("Fix", "${{ (steps.review.outcome ?? 'aprove') == 'approve' }}")),
    );

    expect(problems.map((problem) => problem.message)).toEqual([
      'The step "review" has no outcome "aprove"',
    ]);
  });

  it("reports a reference problem in an approval message at its field", () => {
    const approval = [
      "  - id: approve",
      "    type: approval",
      "    message: Check ${{ steps.deploy.summary }}",
    ];

    const problems = problemsOf(withStep(...approval));

    expect(problems).toEqual([
      {
        line: 11,
        column: 5,
        path: ["steps", 1, "message"],
        message: 'The step "deploy" does not run before this step',
      },
    ]);
  });

  it.each([
    [
      ["    outcomes: { done: ok, blocked: fail }"],
      "${{ steps.fix.outcome == 'blocked' }}",
      'The outcome "blocked" fails the step "fix", so a later step cannot see it',
    ],
    [
      [],
      "${{ steps.approve.outcome == 'rejected' }}",
      'The outcome "rejected" fails the step "approve", so a later step cannot see it',
    ],
  ])("refuses a comparison with an outcome that fails the step", (fields, condition, message) => {
    const approval = ["  - id: approve", "    type: approval", "    message: Check"];
    const ship = [
      "  - id: ship",
      "    type: approval",
      "    message: Ship",
      `    if: "${condition}"`,
    ];

    const problems = problemsOf(withStep(...fixStep("Fix"), ...fields, ...approval, ...ship));

    expect(problems.map((problem) => problem.message)).toEqual([message]);
  });

  it("accepts an outcome that fails the step as the default of ??", () => {
    const condition = "${{ (steps.fix.outcome ?? 'blocked') == 'blocked' }}";
    const ship = [
      "  - id: ship",
      "    type: approval",
      "    message: Ship",
      `    if: "${condition}"`,
    ];

    const result = parse(
      withStep(...fixStep("Fix"), "    outcomes: { done: ok, blocked: fail }", ...ship),
    );

    expect(result.ok).toBe(true);
  });

  it("knows the outcomes of an approval step", () => {
    const approval = ["  - id: approve", "    type: approval", "    message: Check"];

    const problems = problemsOf(
      withStep(...approval, ...fixStep("Fix", "${{ steps.approve.outcome == 'accepted' }}")),
    );

    expect(problems.map((problem) => problem.message)).toEqual([
      'The step "approve" has no outcome "accepted"',
    ]);
  });

  it.each([
    ["${{ steps.review.outcome }}", "The condition is not true or false"],
    ["${{ !steps.review.summary }}", "steps.review.summary is not true or false"],
    ["${{ true && steps.review.summary }}", "steps.review.summary is not true or false"],
    ["${{ false || steps.review.summary }}", "steps.review.summary is not true or false"],
    [
      "${{ steps.review.outputs.changed_files == 'a.ts' }}",
      "Compare a list or a map only with null",
    ],
    [
      "${{ steps.review.outputs.cost_usd == '1' }}",
      "Compare two values of the same type, not a number and a string",
    ],
    [
      "${{ contains(steps.review.outputs, 'a.ts') }}",
      "Use a string or a list of strings, numbers or booleans as the first argument of contains",
    ],
    [
      "${{ contains(steps.review.outputs.changed_files, 1) }}",
      "Use a string as the second argument of contains",
    ],
    ["${{ contains(steps.review.summary, 1) }}", "Use a string as the second argument of contains"],
    [
      "${{ starts_with(steps.review.outputs.cost_usd, 'a') }}",
      "Use a string or a list of strings as the first argument of starts_with",
    ],
    [
      "${{ starts_with(steps.review.summary, 1) }}",
      "Use a string as the second argument of starts_with",
    ],
    [
      "${{ steps.review.status == 'failed' }}",
      "Use succeeded or skipped: a later step sees no other status",
    ],
    [
      "${{ (steps.review.status ?? 'failed') == 'succeeded' }}",
      "Use succeeded or skipped: a later step sees no other status",
    ],
    [
      "${{ (steps.review.outputs.cost_usd ?? 'none') == 'none' }}",
      "Give ?? two values of the same type",
    ],
  ])("refuses the types of the condition %s", (condition, message) => {
    const problems = problemsOf(withStep(...fixStep("Fix", condition)));

    expect(problems).toEqual([{ line: 13, column: 5, path: ["steps", 1, "if"], message }]);
  });

  it.each([
    "${{ contains(steps.review.outputs.changed_files, 'a.ts') }}",
    "${{ contains(steps.review.summary, 'Done') }}",
    "${{ starts_with(steps.review.outputs.changed_files, 'src/') }}",
    "${{ steps.review.status == 'skipped' }}",
    "${{ (steps.review.outputs.findings ?? null) != null }}",
    "${{ (steps.review.outputs.changed_files ?? null) != null }}",
  ])("accepts the condition %s", (condition) => {
    expect(parse(withStep(...fixStep("Fix", condition))).ok).toBe(true);
  });

  it("reports only the reference problem of a value with a wrong reference", () => {
    const problems = problemsOf(withStep(...fixStep("Fix", "${{ !steps.review.outputs.title }}")));

    expect(problems.map((problem) => problem.message)).toEqual([
      'The step "review" has no output "title"',
    ]);
  });

  it("accepts a ?? of two types in a template", () => {
    const prompt = "Fix ${{ steps.review.outputs.cost_usd ?? 'none' }}";

    expect(parse(withStep(...fixStep(prompt))).ok).toBe(true);
  });

  const readOnlyReview = [
    "  - id: review",
    "    type: agent",
    "    agent: codex",
    "    prompt: Review",
    "    permissions: { write: false }",
  ];
  const approval = (reviewers: string) => [
    "  - id: approve",
    "    type: approval",
    "    message: Check",
    `    reviewers: ${reviewers}`,
  ];

  it("parses the reviewers of an approval step", () => {
    const result = parse(["name: Ship", "steps:", ...readOnlyReview, ...approval("[review]")]);

    expect(result).toMatchObject({ ok: true, value: { steps: [{}, { reviewers: ["review"] }] } });
  });

  it("refuses a reviewer that is not before the approval step", () => {
    const problems = problemsOf([
      "name: Ship",
      "steps:",
      ...approval("[review]"),
      ...readOnlyReview,
    ]);

    expect(problems).toMatchObject([
      {
        path: ["steps", 0, "reviewers", 0],
        message: 'The step "review" is not before this step',
      },
    ]);
  });

  it("refuses a reviewer that can write", () => {
    const problems = problemsOf(["name: Ship", "steps:", ...agentStep, ...approval("[implement]")]);

    expect(problems.map((problem) => problem.message)).toEqual([
      'The step "implement" is not an agent step with write: false',
    ]);
  });

  it("refuses an empty list of reviewers", () => {
    const problems = problemsOf(["name: Ship", "steps:", ...readOnlyReview, ...approval("[]")]);

    expect(problems.map((problem) => problem.message)).toEqual(["Add at least one step"]);
  });

  it("refuses a reviewer that is not an agent step", () => {
    const problems = problemsOf(["name: Ship", "steps:", ...shellStep, ...approval("[build]")]);

    expect(problems.map((problem) => problem.message)).toEqual([
      'The step "build" is not an agent step with write: false',
    ]);
  });

  it("accepts a reviewer in the same loop before the approval step", () => {
    const lines = [
      "name: Ship",
      "steps:",
      "  - id: rounds",
      "    type: loop",
      "    max_iterations: 2",
      "    until: ${{ steps.approve.outcome == 'approved' }}",
      "    steps:",
      ...[...readOnlyReview, ...approval("[review]")].map((line) => `    ${line}`),
    ];

    expect(parse(lines).ok).toBe(true);
  });

  const loopOf = ({
    prompt = "Fix",
    until = "${{ steps.review.outcome == 'approve' }}",
  }: { prompt?: string; until?: string } = {}) => [
    "  - id: fix_loop",
    "    type: loop",
    "    max_iterations: 3",
    `    until: "${until}"`,
    "    steps:",
    "      - id: implement",
    "        type: agent",
    "        agent: claude-code",
    `        prompt: "${prompt}"`,
    "      - id: review",
    "        type: agent",
    "        agent: codex",
    "        prompt: Review",
    "        outcomes: [approve, changes_requested]",
    "        outputs: { findings: string }",
  ];
  const withLoop = (loop: string[], ...after: string[]) => [
    "name: Fix",
    "steps:",
    ...shellStep,
    ...loop,
    ...after,
  ];

  it("parses a loop step with its child steps", () => {
    const result = parse(withLoop(loopOf()));

    expect(result).toMatchObject({
      ok: true,
      value: {
        steps: [
          { id: "build" },
          {
            id: "fix_loop",
            type: "loop",
            max_iterations: 3,
            until: "${{ steps.review.outcome == 'approve' }}",
            steps: [{ id: "implement" }, { id: "review" }],
          },
        ],
      },
    });
  });

  it("refuses on_exhausted on a loop with its reason", () => {
    const loop = loopOf();
    loop.splice(4, 0, "    on_exhausted: fail");

    expect(problemsOf(withLoop(loop))).toMatchObject([
      {
        path: ["steps", 1, "on_exhausted"],
        message: "A loop has no on_exhausted. It fails at max_iterations. Delete on_exhausted.",
      },
    ]);
  });

  it.each([
    [["environment: default", "name: Fix", "steps:", ...shellStep], ["environment"]],
    [
      ["name: Fix", "branch: { name: fix, base: main }", "steps:", ...shellStep],
      ["branch", "base"],
    ],
    [
      ["name: Fix", "steps:", "  - { id: pr, type: github, action: open_pull_request, with: {} }"],
      ["steps", 0, "with"],
    ],
  ])("gives the reason of a key that an older schema had: %j", (lines, path) => {
    const [problem] = problemsOf(lines);

    expect(problem).toMatchObject({ path, message: expect.not.stringMatching(/^Unknown key$/) });
  });

  it("reports a loop without max_iterations or until", () => {
    const lines = ["name: Fix", "steps:", "  - id: fix_loop", "    type: loop", "    steps:"];

    const problems = problemsOf([...lines, ...shellStep.map((line) => `    ${line}`)]);

    expect(problems.map(({ path, message }) => [path.at(-1), message])).toEqual([
      ["max_iterations", "Required"],
      ["until", "Required"],
    ]);
  });

  it("refuses a loop inside a loop", () => {
    const inner = ["      - id: inner", "        type: loop"];

    const problems = problemsOf(["name: Fix", "steps:", ...loopOf().slice(0, 5), ...inner]);

    expect(problems).toContainEqual(
      expect.objectContaining({
        path: ["steps", 0, "steps", 0, "type"],
        message: "Use a step type: shell, agent, approval, github",
      }),
    );
  });

  it("reports a step id of a loop child that another step uses", () => {
    const problems = problemsOf(withLoop(loopOf(), ...agentStep));

    expect(problems).toEqual([
      {
        line: 21,
        column: 5,
        path: ["steps", 2, "id"],
        message: 'The step id "implement" is already used',
      },
    ]);
  });

  it("accepts loop.iteration and loop.previous of a later child in a child", () => {
    const prompt = "${{ loop.iteration }} ${{ loop.previous.review.outputs.findings ?? 'none' }}";

    expect(parse(withLoop(loopOf({ prompt }))).ok).toBe(true);
  });

  it("accepts steps.x of a loop child after the loop", () => {
    const after = [
      "  - id: ship",
      "    type: approval",
      "    message: ${{ steps.review.summary }}",
    ];

    expect(parse(withLoop(loopOf(), ...after)).ok).toBe(true);
  });

  it("refuses loop in the if of a loop step", () => {
    const lines = loopOf();
    lines.splice(2, 0, '    if: "${{ loop.iteration == 1 }}"');

    const problems = problemsOf(withLoop(lines));

    expect(problems.map((problem) => problem.message)).toEqual([
      'Unknown name "loop". Use inputs, steps',
    ]);
  });

  it("refuses a step after the loop in until", () => {
    const until = "${{ steps.ship.status == 'succeeded' }}";
    const after = ["  - id: ship", "    type: approval", "    message: Ship"];

    const problems = problemsOf(withLoop(loopOf({ until }), ...after));

    expect(problems.map((problem) => problem.message)).toEqual([
      'The step "ship" does not run before this step',
    ]);
  });

  it.each([
    [
      "max_iterations: 0",
      ["    max_iterations: 0", "    steps:", ...shellStep.map((line) => `    ${line}`)],
      "Use 1 or more",
    ],
    ["steps: []", ["    max_iterations: 1", "    steps: []"], "Add at least one step"],
  ])("refuses the loop field %s", (_field, fields, message) => {
    const loop = ["  - id: fix_loop", "    type: loop", '    until: "${{ true }}"'];

    const problems = problemsOf(["name: Fix", "steps:", ...loop, ...fields]);

    expect(problems.map((problem) => problem.message)).toEqual([message]);
  });

  it.each([
    ["${{ steps.review.summary }}", 'The step "review" does not run before this step'],
    ["${{ loop.previous.deploy.summary }}", 'The step "deploy" is not in this loop'],
    ["${{ loop.previous }}", "Use loop.previous.<step id>.<field>"],
    ["${{ loop.count }}", "Use loop.iteration or loop.previous.<step id>.<field>"],
    ["${{ loop.iteration.x }}", '"loop.iteration" is a number. Remove the rest of the path'],
    ["${{ issue.number }}", 'Unknown name "issue". Use inputs, steps, loop'],
  ])("refuses the reference %s in a loop child", (expression, message) => {
    const problems = problemsOf(withLoop(loopOf({ prompt: `Fix ${expression}` })));

    expect(problems).toEqual([
      { line: 14, column: 9, path: ["steps", 1, "steps", 0, "prompt"], message },
    ]);
  });

  it("refuses loop outside a loop", () => {
    const problems = problemsOf(
      withLoop(
        loopOf(),
        "  - id: ship",
        "    type: approval",
        "    message: ${{ loop.iteration }}",
      ),
    );

    expect(problems.map((problem) => problem.message)).toEqual([
      'Unknown name "loop". Use inputs, steps',
    ]);
  });

  it("refuses an outcome in until that the step does not declare", () => {
    const problems = problemsOf(
      withLoop(loopOf({ until: "${{ steps.review.outcome == 'aprove' }}" })),
    );

    expect(problems).toEqual([
      {
        line: 9,
        column: 5,
        path: ["steps", 1, "until"],
        message: 'The step "review" has no outcome "aprove"',
      },
    ]);
  });

  it("refuses an until that is not true or false", () => {
    const problems = problemsOf(withLoop(loopOf({ until: "${{ steps.review.summary }}" })));

    expect(problems).toEqual([
      {
        line: 9,
        column: 5,
        path: ["steps", 1, "until"],
        message: "The condition is not true or false",
      },
    ]);
  });

  it("refuses a status of loop.previous that a later step cannot see", () => {
    const until = "${{ (loop.previous.review.status ?? 'skipped') == 'failed' }}";

    const problems = problemsOf(withLoop(loopOf({ until })));

    expect(problems.map((problem) => problem.message)).toEqual([
      "Use succeeded or skipped: a later step sees no other status",
    ]);
  });

  it("refuses an outcome of loop.previous that the step does not declare", () => {
    const condition = "${{ (loop.previous.review.outcome ?? 'approve') == 'reject' }}";

    const problems = problemsOf(withLoop(loopOf({ until: condition })));

    expect(problems.map((problem) => problem.message)).toEqual([
      'The step "review" has no outcome "reject"',
    ]);
  });

  const agents = {
    "claude-code": {
      canReportCost: true,
      canAskPermission: true,
      tools: {
        needs: {
          Edit: "write",
          Bash: "shell",
          WebFetch: "network",
          WebSearch: "anyHost",
        } as const,
      },
    },
    codex: { canReportCost: false, canAskPermission: false },
  };
  const parseWith = (lines: string[]) => parseWorkflow(sourceOf(lines), { agents });
  const agentLines = (agent: string, ...fields: string[]) => [
    "name: Fix",
    "steps:",
    "  - id: review",
    "    type: agent",
    `    agent: ${agent}`,
    "    prompt: Review",
    ...fields,
  ];

  it("refuses an unknown agent", () => {
    expect(parseWith(agentLines("gemini"))).toMatchObject({
      ok: false,
      problems: [
        {
          line: 5,
          column: 5,
          path: ["steps", 0, "agent"],
          message: 'There is no agent "gemini". Use claude-code, codex',
        },
      ],
    });
  });

  it("accepts a tool that needs no permission", () => {
    expect(parseWith(agentLines("claude-code", "    tools: [Read]")).ok).toBe(true);
  });

  it.each([
    ["Edit", "      write: true"],
    ["Bash", "      shell: true"],
    ["WebFetch", "      network: [example.com]"],
    ["WebFetch", "      network: true"],
    ["WebSearch", "      network: true"],
  ])("accepts the tool %s with %s", (tool, permission) => {
    const fields = [`    tools: [${tool}]`, "    permissions:", permission];

    expect(parseWith(agentLines("claude-code", ...fields)).ok).toBe(true);
  });

  it.each([
    ["Edit", ["      write: false"]],
    ["Bash", ["      shell: false"]],
    ["WebFetch", ["      network: false"]],
    ["WebFetch", ["      network: []"]],
    ["WebSearch", ["      network: [example.com]"]],
  ])("refuses the tool %s with the permissions %j", (tool, permissions) => {
    const fields = [`    tools: [Read, ${tool}]`, "    permissions:", ...permissions];

    expect(parseWith(agentLines("claude-code", ...fields))).toMatchObject({
      ok: false,
      problems: [{ path: ["steps", 0, "tools", 1] }],
    });
  });

  it("refuses WebFetch for a step without the network permission", () => {
    expect(parseWith(agentLines("claude-code", "    tools: [WebFetch]"))).toMatchObject({
      ok: false,
      problems: [{ path: ["steps", 0, "tools", 0] }],
    });
  });

  it("does not read a tool name as a property of the need list", () => {
    expect(parseWith(agentLines("claude-code", "    tools: [constructor]")).ok).toBe(true);
  });

  it("refuses tools for an agent that has no list of tools", () => {
    expect(parseWith(agentLines("codex", "    tools: [Read]"))).toMatchObject({
      ok: false,
      problems: [{ path: ["steps", 0, "tools"] }],
    });
  });

  it("accepts the model of a step", () => {
    expect(parseWith(agentLines("codex", "    model: small"))).toMatchObject({
      ok: true,
      value: { steps: [{ model: "small" }] },
    });
  });

  it("accepts the MCP servers of a step", () => {
    const fields = [
      "    mcp_servers:",
      "      - name: docs",
      "        command: docs-server",
      "        args: [--stdio]",
    ];

    expect(parseWith(agentLines("codex", ...fields))).toMatchObject({
      ok: true,
      value: {
        steps: [{ mcp_servers: [{ name: "docs", command: "docs-server", args: ["--stdio"] }] }],
      },
    });
  });

  it("refuses the name of the report server for an MCP server", () => {
    const fields = ["    mcp_servers:", "      - { name: halinka, command: docs-server }"];

    expect(parseWith(agentLines("codex", ...fields))).toMatchObject({
      ok: false,
      problems: [{ path: ["steps", 0, "mcp_servers", 0, "name"] }],
    });
  });

  it("refuses a repeated MCP server name", () => {
    const fields = [
      "    mcp_servers:",
      "      - { name: docs, command: one }",
      "      - { name: docs, command: two }",
    ];

    expect(parseWith(agentLines("codex", ...fields))).toMatchObject({
      ok: false,
      problems: [{ path: ["steps", 0, "mcp_servers", 1, "name"] }],
    });
  });

  it("refuses an environment on an MCP server", () => {
    const fields = [
      "    mcp_servers:",
      "      - name: docs",
      "        command: docs-server",
      "        env: { TOKEN: value }",
    ];

    expect(parseWith(agentLines("codex", ...fields))).toMatchObject({
      ok: false,
      problems: [{ path: ["steps", 0, "mcp_servers", 0, "env"], message: "Unknown key" }],
    });
  });

  it("refuses shell: false for an agent that runs commands without asking", () => {
    const fields = ["    permissions:", "      shell: false"];

    expect(parseWith(agentLines("codex", ...fields))).toMatchObject({
      ok: false,
      problems: [{ path: ["steps", 0, "permissions", "shell"] }],
    });
  });

  it("accepts shell: false for an agent that asks before it runs a tool", () => {
    expect(parseWith(agentLines("claude-code", "    permissions:", "      shell: false")).ok).toBe(
      true,
    );
  });

  it("accepts an unknown agent without a list of agents", () => {
    expect(parse(agentLines("gemini")).ok).toBe(true);
  });

  it("refuses max_cost_usd of an agent that reports no cost", () => {
    expect(parseWith(agentLines("codex", "    max_cost_usd: 2"))).toMatchObject({
      ok: false,
      problems: [
        {
          line: 7,
          column: 5,
          path: ["steps", 0, "max_cost_usd"],
          message: 'The agent "codex" reports no cost. Remove max_cost_usd',
        },
      ],
    });
  });

  const loopLines = (reviewAgent: string) => [
    "name: Fix",
    "steps:",
    "  - id: fix_loop",
    "    type: loop",
    "    max_iterations: 2",
    "    max_cost_usd: 5",
    '    until: "${{ true }}"',
    "    steps:",
    "      - { id: implement, type: agent, agent: claude-code, prompt: Fix, max_cost_usd: 2 }",
    `      - { id: review, type: agent, agent: ${reviewAgent}, prompt: Review }`,
  ];

  it("refuses an unknown agent of a loop child", () => {
    expect(parseWith(loopLines("gemini"))).toMatchObject({
      ok: false,
      problems: [{ path: ["steps", 0, "steps", 1, "agent"] }],
    });
  });

  it("refuses max_cost_usd of the workflow with an agent that reports no cost", () => {
    expect(parseWith(["max_cost_usd: 2", ...agentLines("codex")])).toMatchObject({
      ok: false,
      problems: [
        {
          path: ["max_cost_usd"],
          message: 'The agent "codex" of the step "review" reports no cost. Remove max_cost_usd',
        },
      ],
    });
  });

  it("refuses max_cost_usd of the workflow with a loop child whose agent reports no cost", () => {
    expect(parseWith(["max_cost_usd: 9", ...loopLines("codex")])).toMatchObject({
      ok: false,
      problems: expect.arrayContaining([expect.objectContaining({ path: ["max_cost_usd"] })]),
    });
  });

  it("refuses a max_cost_usd of 0 for the workflow", () => {
    expect(parseWith(["max_cost_usd: 0", ...agentLines("claude-code")])).toMatchObject({
      ok: false,
      problems: [{ path: ["max_cost_usd"], message: "Use more than 0" }],
    });
  });

  it("accepts max_cost_usd of the workflow with agents that report cost", () => {
    expect(parseWith(["max_cost_usd: 2", ...agentLines("claude-code")]).ok).toBe(true);
  });

  it("accepts max_cost_usd of agents that report cost", () => {
    expect(parseWith(loopLines("claude-code")).ok).toBe(true);
  });

  it("refuses max_cost_usd of a loop with a child agent that reports no cost", () => {
    expect(parseWith(loopLines("codex"))).toMatchObject({
      ok: false,
      problems: [
        {
          line: 6,
          column: 5,
          path: ["steps", 0, "max_cost_usd"],
          message: 'The agent "codex" of the step "review" reports no cost. Remove max_cost_usd',
        },
      ],
    });
  });

  const readCost = (agent: string) => [
    ...agentLines(agent),
    "  - id: fix",
    "    type: agent",
    "    agent: claude-code",
    "    prompt: Fix ${{ steps.review.outputs.cost_usd }}",
  ];

  it("reads cost_usd of an agent that reports cost", () => {
    expect(parseWith(readCost("claude-code")).ok).toBe(true);
  });

  it("refuses cost_usd of an agent that reports no cost", () => {
    expect(parseWith(readCost("codex"))).toMatchObject({
      ok: false,
      problems: [
        { path: ["steps", 1, "prompt"], message: 'The step "review" has no output "cost_usd"' },
      ],
    });
  });

  it("reports an agent step without an agent or a prompt", () => {
    expect(problemsOf(["name: Fix", "steps:", "  - id: implement", "    type: agent"])).toEqual([
      { line: 3, column: 5, path: ["steps", 0, "agent"], message: "Required" },
      { line: 3, column: 5, path: ["steps", 0, "prompt"], message: "Required" },
    ]);
  });

  const parseOn = (on: string[]) =>
    parse([
      "name: Fix",
      "inputs:",
      "  issue_number: { type: number, required: true }",
      "  text: { type: string, default: none }",
      "on:",
      ...on,
      "steps:",
      ...shellStep,
    ]);

  const problemsOfOn = (on: string[]) => {
    const result = parseOn(on);
    return result.ok ? [] : result.problems;
  };

  const messagesOfOn = (on: string[]) => problemsOfOn(on).map(({ message }) => message);

  const cron = (schedule: string, ...inputs: string[]) => [
    "  cron:",
    `    schedule: "${schedule}"`,
    ...inputs,
  ];

  const cronNumber = ["    inputs:", '      issue_number: "7"'];

  it("takes a cron trigger with fixed inputs", () => {
    expect(messagesOfOn(cron("0 6 * * *", ...cronNumber))).toEqual([]);
  });

  it("refuses a cron schedule that is not valid", () => {
    expect(messagesOfOn(cron("61 * * * *", ...cronNumber))).toEqual([
      "Use five fields in UTC and a date that exists, for example 0 6 * * 1-5",
    ]);
  });

  it("needs a value for each required input of a cron trigger", () => {
    expect(messagesOfOn(cron("0 6 * * *"))).toEqual([
      'Give a value to the required input "issue_number"',
    ]);
  });

  it("refuses a field of an event in a cron trigger, because a schedule has no event", () => {
    const on = cron("0 6 * * *", "    inputs:", "      issue_number: ${{ event.issue.number }}");

    expect(messagesOfOn(on)).toEqual(['"event" has no field "issue"']);
  });

  const issues = (number: string, ...mapping: string[]) => [
    "  issues:",
    "    types: [opened]",
    "    inputs:",
    `      issue_number: ${number}`,
    ...mapping.map((line) => `      ${line}`),
  ];

  const issuesWith = (...mapping: string[]) => issues("${{ event.issue.number }}", ...mapping);

  it("parses both events", () => {
    const comment = [
      "  issue_comment:",
      "    starts_with: /halinka",
      "    inputs:",
      "      issue_number: ${{ event.issue.number }}",
      "      text: ${{ event.comment.body }}",
    ];

    expect(messagesOfOn([...issuesWith(), ...comment])).toEqual([]);
  });

  it("refuses an event that it does not know", () => {
    expect(messagesOfOn(["  deployment:", "    types: [opened]"])).toEqual(["Unknown key"]);
  });

  it("refuses a type that it does not know", () => {
    const on = ["  issues:", "    types: [closed]"];

    expect(messagesOfOn(on)).toEqual([
      'Invalid option: expected one of "opened"|"reopened"|"labeled"',
    ]);
  });

  it.each([
    [["  issues:", "    types: []"], "Add at least one type"],
    [["  issues:", "    types: [opened]", "    labels: []"], "Add at least one label"],
    [["  issue_comment:", "    starts_with: ' '"], "Must not be empty"],
  ])("refuses an empty filter: %j", (on, message) => {
    expect(messagesOfOn(on)).toContain(message);
  });

  it("does not check the mapping when its shape has a problem", () => {
    const on = ["  issues:", "    types: [opened]", "    inputs: 5"];

    expect(messagesOfOn(on)).toEqual(["Use a record"]);
  });

  it("reports a mapping to an input that the workflow does not have at its key", () => {
    expect(problemsOfOn(issuesWith("other: ${{ event.issue.title }}"))).toMatchObject([
      { path: ["on", "issues", "inputs", "other"], message: 'The workflow has no input "other"' },
    ]);
  });

  it("refuses a required input with no value", () => {
    expect(problemsOfOn(["  issues:", "    types: [opened]"])).toMatchObject([
      {
        path: ["on", "issues", "inputs"],
        message: 'Give a value to the required input "issue_number"',
      },
    ]);
  });

  it("checks the mapping of a comment", () => {
    const on = ["  issue_comment:", "    starts_with: /halinka"];

    expect(messagesOfOn(on)).toEqual(['Give a value to the required input "issue_number"']);
  });

  it("refuses a value of another type", () => {
    expect(messagesOfOn(issues("${{ event.issue.title }}"))).toEqual([
      "Give a number to this field",
    ]);
  });

  it("refuses text around the value of a number input", () => {
    expect(problemsOfOn(issues("a${{ event.issue.number }}"))).toMatchObject([
      {
        path: ["on", "issues", "inputs", "issue_number"],
        message: "Use one ${{ }} and no other text for a number input",
      },
    ]);
  });

  it("refuses a constant of another type", () => {
    expect(messagesOfOn(issues("abc"))).toEqual(["Use a number"]);
  });

  it("accepts a constant of the type of the input", () => {
    expect(messagesOfOn(issues("'7'"))).toEqual([]);
  });

  it("refuses a map in a value with text around it", () => {
    expect(messagesOfOn(issuesWith("text: 'Issue ${{ event.issue }}'"))).toEqual([
      "Read a string, a number or a boolean",
    ]);
  });

  it("refuses a field that can have no value, with no default", () => {
    expect(messagesOfOn(issuesWith("text: ${{ event.issue.body }}"))).toEqual([
      "event.issue.body can have no value. Add a default with ??",
    ]);
  });

  it("accepts a field that can have no value, with a default", () => {
    expect(messagesOfOn(issuesWith("text: ${{ event.issue.body ?? '' }}"))).toEqual([]);
  });

  it("refuses a field of another event", () => {
    expect(messagesOfOn(issuesWith("text: ${{ event.comment.body }}"))).toEqual([
      '"event" has no field "comment"',
    ]);
  });

  it("refuses another root in a mapping", () => {
    expect(messagesOfOn(issuesWith("text: ${{ inputs.text }}"))).toEqual([
      'Unknown name "inputs". Use event',
    ]);
  });

  it("refuses the event in a prompt", () => {
    const problems = problemsOf([
      "name: Fix",
      "steps:",
      ...agentStep.slice(0, 3),
      '    prompt: "${{ event.issue.title }}"',
    ]);

    expect(problems.map(({ message }) => message)).toEqual([
      'Unknown name "event". Use inputs, steps',
    ]);
  });

  it("reports each unknown key at its position", () => {
    expect(
      problemsOf(["name: Build", "trigger: {}", "steps:", ...shellStep, "    tmeout: 5m"]),
    ).toEqual([
      { line: 2, column: 1, path: ["trigger"], message: "Unknown key" },
      { line: 7, column: 5, path: ["steps", 0, "tmeout"], message: "Unknown key" },
    ]);
  });

  it("refuses the key __proto__, which zod drops without a problem", () => {
    expect(
      problemsOf(["name: Build", "inputs:", "  __proto__: {}", "steps:", ...shellStep]),
    ).toEqual([{ line: 3, column: 3, path: [], message: "Do not use the key __proto__" }]);
  });

  it("refuses a key that is not a string", () => {
    expect(problemsOf(["name: Build", "1: x", "steps:", ...shellStep])).toEqual([
      { line: 2, column: 1, path: [], message: "Use a string key" },
    ]);
  });

  it("refuses a key that YAML reads as a boolean, so it cannot replace a string key", () => {
    const problems = problemsOf([
      "name: Fix",
      "steps:",
      ...agentStep,
      '    outcomes: { true: fail, "true": ok }',
    ]);

    expect(problems).toEqual([{ line: 7, column: 17, path: [], message: "Use a string key" }]);
  });

  it("refuses an alias inside its own anchor", () => {
    const problems = problemsOf([
      "name: Fix",
      "steps:",
      ...agentStep,
      "    outputs: &fields { self: *fields }",
    ]);

    expect(problems).toEqual([
      { line: 7, column: 30, path: [], message: "Do not use an alias inside its own anchor" },
    ]);
  });

  it("reports a missing key at its parent", () => {
    expect(problemsOf(["steps:", "  - id: build", "    type: shell"])).toEqual([
      { line: 1, column: 1, path: ["name"], message: "Required" },
      { line: 2, column: 5, path: ["steps", 0, "run"], message: "Required" },
    ]);
  });

  it("reports a key without a value as required", () => {
    expect(
      problemsOf(["name: Build", "steps:", "  - id: build", "    type: shell", "    run:"]),
    ).toEqual([{ line: 5, column: 5, path: ["steps", 0, "run"], message: "Required" }]);
  });

  it("reports an unknown key in flow style at the key", () => {
    expect(
      problemsOf(["name: Build", "steps: [{id: build, type: shell, run: ls, foo: 1}]"]),
    ).toEqual([{ line: 2, column: 43, path: ["steps", 0, "foo"], message: "Unknown key" }]);
  });

  it("reports a value of the wrong type with its YAML name", () => {
    expect(problemsOf(["name: Build", "steps: {}"])).toEqual([
      { line: 2, column: 1, path: ["steps"], message: "Use a list" },
    ]);
    expect(problemsOfSource("- build")).toMatchObject([
      { line: 1, column: 1, path: [], message: "Use a map" },
    ]);
  });

  it("reports an empty file", () => {
    expect(problemsOfSource("# no content")).toMatchObject([
      { line: 1, column: 1, path: [], message: "The file is empty" },
    ]);
    expect(problemsOfSource("~")).toMatchObject([
      { line: 1, column: 1, path: [], message: "The file is empty" },
    ]);
  });

  it("reports a step without a type at the step", () => {
    expect(problemsOf(["name: Build", "steps:", "  - id: build", "    run: ls"])).toEqual([
      {
        line: 3,
        column: 5,
        path: ["steps", 0, "type"],
        message: "Use a step type: shell, agent, approval, github, loop",
      },
    ]);
  });

  it("refuses an unknown action of a github step", () => {
    const steps = [
      "name: Build",
      "steps:",
      "  - id: publish",
      "    type: github",
      "    action: merge",
    ];

    expect(problemsOf(steps)).toMatchObject([{ path: ["steps", 0, "action"] }]);
  });

  it("reports an unknown step type", () => {
    expect(
      problemsOf(["name: Build", "steps:", "  - id: build", "    type: agnt", "    run: ls"]),
    ).toEqual([
      {
        line: 4,
        column: 5,
        path: ["steps", 0, "type"],
        message: "Use a step type: shell, agent, approval, github, loop",
      },
    ]);
  });

  it("refuses blank text, invalid ids and an empty step list", () => {
    const blank = ["name: ' '", "steps:", "  - id: Build-1", "    type: shell", "    run: ''"];
    expect(problemsOf(blank).map((problem) => problem.message)).toEqual([
      "Must not be empty",
      "Start with a letter. Use only lowercase letters, digits and underscores",
      "Must not be empty",
    ]);
    expect(problemsOf(["name: Build", "steps: []"])).toEqual([
      { line: 2, column: 1, path: ["steps"], message: "Add at least one step" },
    ]);
  });

  it("reports a repeated step id at the repeat, also when the step is invalid", () => {
    const invalidStep = ["  - id: build", "    type: shell", "    run: 1"];
    expect(problemsOf(["name: Build", "steps:", ...shellStep, ...invalidStep])).toEqual([
      {
        line: 6,
        column: 5,
        path: ["steps", 1, "id"],
        message: 'The step id "build" is already used',
      },
      { line: 8, column: 5, path: ["steps", 1, "run"], message: "Use a string" },
    ]);
  });

  it("reports every YAML syntax problem", () => {
    expect(
      problemsOf(["name: Build", "steps:", "  - id: a", "   type: shell", "  run: x"]),
    ).toEqual([
      { line: 4, column: 1, path: [], message: "Sequence item without - indicator" },
      { line: 5, column: 1, path: [], message: "All mapping items must start at the same column" },
    ]);
  });

  it("reports the problems of aliases", () => {
    expect(problemsOf(["name: Build", "steps: [*missing]"])).toEqual([
      {
        line: 1,
        column: 1,
        path: [],
        message: "Unresolved alias (the anchor must be set before the alias): missing",
      },
    ]);
    const aliases = Array.from({ length: 101 }, () => "*name").join(", ");
    expect(problemsOf(["name: &name Build", `steps: [${aliases}]`])).toEqual([
      {
        line: 1,
        column: 1,
        path: [],
        message: "Excessive alias count indicates a resource exhaustion attack",
      },
    ]);
  });

  it("refuses merge keys, unknown tags and YAML 1.1", () => {
    const merge = [
      "name: Build",
      "steps:",
      "  - &base",
      "    id: first",
      "    type: shell",
      "    run: ls",
      "  - <<: *base",
      "    id: second",
    ];
    expect(problemsOf(merge)).toEqual([
      { line: 7, column: 5, path: [], message: "Do not use merge keys (<<). Write the keys" },
    ]);
    expect(problemsOf(["name: !foo Build", "steps:", ...shellStep])).toEqual([
      { line: 1, column: 7, path: [], message: "Unresolved tag: !foo" },
    ]);
    expect(problemsOf(["%YAML 1.1", "---", "name: Build", "steps:", ...shellStep])).toEqual([
      { line: 1, column: 1, path: [], message: "Use YAML 1.2" },
    ]);
  });

  it("refuses repeated keys and multiple documents", () => {
    expect(problemsOf(["name: Build", "name: Test", "steps: []"])).toEqual([
      { line: 2, column: 1, path: [], message: "Map keys must be unique" },
    ]);
    expect(problemsOf(["name: Build", "---", "name: Test"])).toEqual([
      { line: 2, column: 1, path: [], message: "Use one YAML document" },
    ]);
  });
});
