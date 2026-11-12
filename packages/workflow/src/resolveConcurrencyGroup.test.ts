import { describe, expect, it } from "vitest";

import { resolveConcurrencyGroup } from "./resolveConcurrencyGroup";
import type { Workflow } from "./workflow";

const workflowWith = (group?: string): Workflow => ({
  name: "Deploy",
  steps: [{ id: "build", type: "shell", run: "ls" }],
  ...(group && { concurrency: { group } }),
});

describe("resolveConcurrencyGroup", () => {
  it("gives no name for a workflow with no group", () => {
    expect(resolveConcurrencyGroup(workflowWith(), {})).toEqual({ ok: true, value: undefined });
  });

  it("fills in the inputs", () => {
    const workflow = workflowWith("deploy-${{ inputs.env }}");

    expect(resolveConcurrencyGroup(workflow, { env: "prod" })).toEqual({
      ok: true,
      value: "deploy-prod",
    });
  });

  it("refuses a name that is empty", () => {
    const workflow = workflowWith("${{ inputs.env }}");

    expect(resolveConcurrencyGroup(workflow, { env: " " })).toMatchObject({ ok: false });
  });

  it("refuses a name that is too long for the index", () => {
    const workflow = workflowWith("${{ inputs.env }}");

    expect(resolveConcurrencyGroup(workflow, { env: "x".repeat(201) })).toMatchObject({
      ok: false,
      problems: [expect.stringContaining("200 characters")],
    });
  });

  it("refuses a name that cannot be filled in", () => {
    const workflow = workflowWith("${{ inputs.env.name }}");

    expect(resolveConcurrencyGroup(workflow, { env: "prod" })).toMatchObject({
      ok: false,
      problems: [expect.stringContaining("Check the concurrency group")],
    });
  });
});
