import { describe, expect, it } from "vitest";

import { newWorkflowSource } from "./newWorkflowSource";
import { parseWorkflow } from "./workflow";

describe("newWorkflowSource", () => {
  it.each([
    ["build.yml", "build"],
    ["build.yaml", "build"],
    ["1.yml", "1"],
    ["on.yaml", "on"],
    ["a: b.yml", "a: b"],
  ])("gives a valid workflow for %s, named after the file", (file, name) => {
    const parsed = parseWorkflow(newWorkflowSource(file));

    expect(parsed.ok && parsed.value.name).toBe(name);
  });
});
