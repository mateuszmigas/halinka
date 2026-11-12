import { describe, expect, it } from "vitest";

import { workflowAgents } from "./leafSteps";
import { parseWorkflow } from "./workflow";

const workflowOf = (source: string) => {
  const parsed = parseWorkflow(source);
  if (!parsed.ok) throw new Error("The test workflow is not valid");
  return parsed.value;
};

describe("workflowAgents", () => {
  it("lists each agent of the steps and of the loop children once, sorted", () => {
    const workflow = workflowOf(
      [
        "schema_version: 1",
        "name: Fix",
        "steps:",
        "  - { id: plan, type: agent, agent: codex, prompt: Plan }",
        "  - id: fix",
        "    type: loop",
        "    max_iterations: 2",
        "    until: \"${{ steps.implement.status == 'succeeded' }}\"",
        "    steps:",
        "      - { id: implement, type: agent, agent: claude-code, prompt: Fix }",
        "      - { id: check, type: agent, agent: codex, prompt: Check }",
      ].join("\n"),
    );

    expect(workflowAgents(workflow)).toEqual(["claude-code", "codex"]);
  });
});
