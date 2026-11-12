import { describe, expect, it } from "vitest";

import { migrateDefinition } from "./migrateDefinition";
import { parseDefinition } from "./parseDefinition";
import { repoConfigPath } from "./repoConfig";

const workflowPath = ".halinka/workflows/build.yml";

const migrate = (lines: string[], path = workflowPath) =>
  migrateDefinition(path, `${lines.join("\n")}\n`);

const linesOf = (lines: string[], path = workflowPath) =>
  migrate(lines, path).source.trimEnd().split("\n");

const messagesAfter = (lines: string[], path = workflowPath) => {
  const parsed = parseDefinition(path, migrate(lines, path).source);
  return parsed.ok ? [] : parsed.problems.map(({ message }) => message);
};

const shellStep = ["  - id: build", "    type: shell", "    run: ls"];

const withSteps = (...lines: string[]) => ["name: Build", "steps:", ...lines];

const versioned = (...lines: string[]) => ["schema_version: 1", ...lines];

const pullRequestStep = (...fields: string[]) => [
  "  - id: pull_request",
  "    type: github",
  "    action: open_pull_request",
  "    with:",
  ...fields.map((field) => `      ${field}`),
];

const loopStep = (...fields: string[]) => [
  "  - id: build",
  "    type: loop",
  "    until: steps.check.status == 'succeeded'",
  ...fields.map((field) => `    ${field}`),
  "    steps:",
  "      - id: check",
  "        type: shell",
  "        run: ls",
];

describe("migrateDefinition", () => {
  it("adds schema_version after the first comments and keeps the other lines as written", () => {
    const lines = [
      "# Build the app",
      "name: Build # the name",
      "inputs: { task: { type: string } }",
      "steps:",
      ...shellStep,
    ];

    expect(linesOf(lines)).toEqual(["# Build the app", "schema_version: 1", ...lines.slice(1)]);
  });

  it("gives a file with schema_version back unchanged", () => {
    const source = "schema_version: 1\nname: Build\nenvironment: default\n";

    expect(migrateDefinition(workflowPath, source)).toEqual({ source, changes: [], notes: [] });
  });

  it("gives a file with a YAML error back unchanged", () => {
    const source = "name: [Build\n";

    expect(migrateDefinition(workflowPath, source)).toEqual({ source, changes: [], notes: [] });
  });

  it("refuses a path that is not a definition", () => {
    expect(() => migrateDefinition(".halinka/notes.yml", "name: Build\n")).toThrow(Error);
  });

  it("deletes environment", () => {
    expect(linesOf(["name: Build", "environment: default", "steps:", ...shellStep])).toEqual(
      versioned(...withSteps(...shellStep)),
    );
  });

  it("writes runs-on text as a list", () => {
    expect(linesOf(["runs-on: gpu", ...withSteps(...shellStep)])).toContain("runs-on: [gpu]");
  });

  it("wraps a bare if in ${{ }}", () => {
    expect(linesOf(withSteps(...shellStep, "    if: inputs.deploy"))).toContain(
      "    if: ${{ inputs.deploy }}",
    );
  });

  it("wraps a quoted if and keeps its quotes", () => {
    expect(linesOf(withSteps(...shellStep, "    if: \"inputs.deploy == 'yes'\""))).toContain(
      "    if: \"${{ inputs.deploy == 'yes' }}\"",
    );
  });

  it("wraps an if in a block scalar", () => {
    const lines = withSteps(...shellStep, "    if: |-", "      inputs.deploy");

    expect(linesOf(lines).slice(-2)).toEqual(["    if: |-", "      ${{ inputs.deploy }}"]);
  });

  it("keeps a condition that has ${{ }}", () => {
    const lines = withSteps(...shellStep, "    if: ${{ inputs.deploy }}");

    expect(linesOf(lines)).toEqual(versioned(...lines));
  });

  it("wraps the if of a step in a loop", () => {
    expect(
      linesOf(withSteps(...loopStep("max_iterations: 2"), "        if: inputs.check")),
    ).toContain("        if: ${{ inputs.check }}");
  });

  it("wraps the until of a loop", () => {
    expect(linesOf(withSteps(...loopStep("max_iterations: 2")))).toContain(
      "    until: ${{ steps.check.status == 'succeeded' }}",
    );
  });

  it("adds the old default of max_iterations to a loop without it", () => {
    expect(linesOf(withSteps(...loopStep())).slice(4, 6)).toEqual([
      "    type: loop",
      "    max_iterations: 5",
    ]);
  });

  it("deletes on_exhausted: fail of a loop", () => {
    expect(linesOf(withSteps(...loopStep("max_iterations: 2", "on_exhausted: fail")))).toEqual(
      versioned(
        ...withSteps(...loopStep("max_iterations: 2")).map((line) =>
          line.replace(
            "steps.check.status == 'succeeded'",
            "${{ steps.check.status == 'succeeded' }}",
          ),
        ),
      ),
    );
  });

  it("keeps on_exhausted: ask_human of a loop, and the parse gives the reason", () => {
    expect(
      messagesAfter(withSteps(...loopStep("max_iterations: 2", "on_exhausted: ask_human"))),
    ).toEqual(["A loop has no on_exhausted. It fails at max_iterations. Delete on_exhausted."]);
  });

  it("moves the title and the body of a pull request to the step", () => {
    const lines = withSteps(...pullRequestStep("title: Fix", "body: |", "  Done", "  Now"));

    expect(linesOf(lines)).toEqual(
      versioned(
        ...withSteps(
          "  - id: pull_request",
          "    type: github",
          "    action: open_pull_request",
          "    title: Fix",
          "    body: |",
          "      Done",
          "      Now",
        ),
      ),
    );
  });

  it("keeps a title of the pull request that the step has", () => {
    const lines = withSteps(...pullRequestStep("title: Old"), "    title: New");

    expect(linesOf(lines)).toEqual(versioned(...lines));
  });

  it("deletes a with that holds only draft: false", () => {
    expect(linesOf(withSteps(...pullRequestStep("draft: false")))).toEqual(
      versioned(
        ...withSteps("  - id: pull_request", "    type: github", "    action: open_pull_request"),
      ),
    );
  });

  it("keeps with when it has draft: true, and the parse gives the reason", () => {
    const lines = withSteps(...pullRequestStep("title: Fix", "draft: true"));

    expect(messagesAfter(lines)).toEqual([
      "A github step has no with. Write title and body on the step. A pull request is not a draft and merges into the default branch.",
    ]);
  });

  it("renames startsWith in a template", () => {
    const lines = withSteps(...shellStep, "    if: ${{ startsWith(inputs.task, 'fix') }}");

    expect(linesOf(lines)).toContain("    if: ${{ starts_with(inputs.task, 'fix') }}");
  });

  it("renames startsWith in a bare if", () => {
    expect(linesOf(withSteps(...shellStep, "    if: startsWith(inputs.task, 'fix')"))).toContain(
      "    if: ${{ starts_with(inputs.task, 'fix') }}",
    );
  });

  it("does not migrate a step in flow style", () => {
    const lines = withSteps("  - { id: build, type: shell, run: ls, if: inputs.deploy }");

    expect(linesOf(lines)).toEqual(versioned(...lines));
  });

  it("gives each change the line of the old file", () => {
    const lines = [
      "name: Build",
      "environment: default",
      "steps:",
      ...shellStep,
      "    if: inputs.deploy",
    ];

    expect(migrate(lines).changes.map(({ line }) => line)).toEqual([1, 2, 7]);
  });

  it("gives a migrated legacy workflow with no problems", () => {
    const lines = [
      "name: Build",
      "environment: default",
      "steps:",
      ...loopStep("on_exhausted: fail"),
      ...pullRequestStep("title: Fix", "body: Done", "draft: false"),
    ];

    expect(messagesAfter(lines)).toEqual([]);
  });

  it("moves the devcontainer of the one environment of config.yml", () => {
    const lines = [
      "server: local",
      "environments:",
      "  default:",
      "    devcontainer: .devcontainer/devcontainer.json",
    ];

    expect(linesOf(lines, repoConfigPath)).toEqual(
      versioned("server: local", "devcontainer: .devcontainer/devcontainer.json"),
    );
  });

  it("deletes a host environment of config.yml", () => {
    const lines = [
      "server: local",
      "environments:",
      "  default:",
      "    sandbox: host",
      "    devcontainer: dc.json",
    ];

    expect(linesOf(lines, repoConfigPath)).toEqual(versioned("server: local"));
  });

  it("keeps several environments of config.yml, and the parse gives the reason", () => {
    const lines = [
      "server: local",
      "environments:",
      "  default: { devcontainer: a.json }",
      "  e2e: { devcontainer: b.json }",
    ];

    expect(messagesAfter(lines, repoConfigPath)).toEqual([
      "A repo has one devcontainer. Write devcontainer: <path> and delete environments.",
    ]);
  });

  it("gives a config.yml without server a problem that asks for it", () => {
    const lines = ["environments:", "  default:", "    devcontainer: dc.json"];

    expect(messagesAfter(lines, repoConfigPath)).toEqual([
      "Add server: local, or the URL of your Halinka server",
    ]);
  });
  it("keeps the list marker of a step whose first key moves", () => {
    const lines = withSteps(
      "  - with:",
      "      title: Fix",
      "    id: pull_request",
      "    type: github",
      "    action: open_pull_request",
    );

    expect(linesOf(lines)).toEqual(
      versioned(
        ...withSteps(
          "  - title: Fix",
          "    id: pull_request",
          "    type: github",
          "    action: open_pull_request",
        ),
      ),
    );
  });

  it("keeps the list marker of a step whose first key is deleted", () => {
    const lines = withSteps(
      "  - on_exhausted: fail",
      "    id: build",
      "    type: loop",
      "    max_iterations: 2",
      "    until: ${{ true }}",
      "    steps:",
      ...shellStep.map((line) => `    ${line}`),
    );

    expect(linesOf(lines).slice(3, 5)).toEqual(["  - id: build", "    type: loop"]);
  });

  it("renames startsWith in a title that moves", () => {
    const lines = withSteps(
      ...pullRequestStep(
        "title: ${{ startsWith(inputs.a, 'x') }} ${{ startsWith(inputs.a, 'y') }}",
      ),
    );

    expect(linesOf(lines).at(-1)).toBe(
      "    title: ${{ starts_with(inputs.a, 'x') }} ${{ starts_with(inputs.a, 'y') }}",
    );
  });

  it("keeps startsWith in a string of an expression and in the text around it", () => {
    const lines = withSteps(
      "  - id: approve",
      "    type: approval",
      "    message: Use name.startsWith(x) for ${{ 'startsWith(' }}",
    );

    expect(linesOf(lines)).toEqual(versioned(...lines));
  });

  it("keeps the body of a pull request as written, with its comments", () => {
    const lines = withSteps(
      ...pullRequestStep("title: Fix", "# the body", "body: |+", "  Done", "", "draft: false"),
    );

    expect(migrate(lines).source).toContain(
      "    title: Fix\n    # the body\n    body: |+\n      Done\n    \n",
    );
  });

  it("indents schema_version as the first key", () => {
    expect(linesOf(["  name: Build", "  steps:", `  ${shellStep[0]}`])[0]).toBe(
      "  schema_version: 1",
    );
  });

  it("adds schema_version after a byte order mark", () => {
    const { source } = migrateDefinition(workflowPath, "﻿name: Build\n");

    expect(source).toBe("﻿schema_version: 1\nname: Build\n");
  });

  it("writes new lines with the line end of the file", () => {
    const source = ["name: Build", "steps:", ...loopStep("on_exhausted: fail")].join("\r\n");

    expect(migrateDefinition(workflowPath, source).source.replaceAll("\r\n", "")).not.toContain(
      "\n",
    );
  });

  it("adds schema_version to a root map in flow style", () => {
    expect(migrateDefinition(workflowPath, "{name: Build}\n").source).toBe(
      "{schema_version: 1, name: Build}\n",
    );
  });

  it("writes schema_version above the devcontainer of a config.yml that starts with environments", () => {
    const lines = ["environments:", "  default:", "    devcontainer: dc.json", "server: local"];

    expect(linesOf(lines, repoConfigPath)).toEqual([
      "schema_version: 1",
      "devcontainer: dc.json",
      "server: local",
    ]);
  });

  it("notes that a step reaches no network unless it names the hosts", () => {
    expect(migrate(withSteps(...shellStep)).notes).toEqual([
      "A step reaches no network now unless it names the hosts in network. Add network to each step that needs it.",
    ]);
  });
});
