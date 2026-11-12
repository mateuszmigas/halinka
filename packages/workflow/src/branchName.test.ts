import { describe, expect, it } from "vitest";

import { isBranchName, resolveBranchName } from "./branchName";
import type { Workflow } from "./workflow";

const workflowOf = (name?: string): Workflow => ({
  name: "Fix",
  inputs: { issue: { type: "number" } },
  ...(name !== undefined && { branch: { name } }),
  steps: [{ id: "fix", type: "shell", run: "ls" }],
});

describe("branchName", () => {
  it.each(["fix", "halinka/fix-1.2", "feature/a_b", "a.lock.b", "a/HEAD"])("accepts %j", (name) => {
    expect(isBranchName(name)).toBe(true);
  });

  it.each([
    "",
    "fix it",
    "fix\tit",
    "fix\u0001",
    "fix..it",
    "a//b",
    "fix/",
    "/fix",
    ".fix",
    "fix.",
    "-fix",
    "a/.b",
    "fix.lock",
    "a.lock/b",
    "fix@{1}",
    "@",
    "a~b",
    "a^b",
    "a:b",
    "a?b",
    "a*b",
    "a[b",
    "a\\b",
    "HEAD",
  ])("refuses %j", (name) => {
    expect(isBranchName(name)).toBe(false);
  });

  it("fills in the inputs", () => {
    expect(resolveBranchName(workflowOf("fix/issue-${{ inputs.issue }}"), { issue: 12 })).toEqual({
      ok: true,
      value: "fix/issue-12",
    });
  });

  it("gives no name for a workflow without a branch", () => {
    expect(resolveBranchName(workflowOf(), {})).toEqual({ ok: true, value: undefined });
  });

  it("refuses a name that the inputs make invalid", () => {
    expect(resolveBranchName(workflowOf("fix/${{ inputs.issue }}."), { issue: 12 })).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/^The branch name "fix\/12\." is not valid\./)],
    });
  });

  it("refuses a name that cannot be filled in", () => {
    expect(
      resolveBranchName(workflowOf("fix-${{ contains(inputs.issue, '1') }}"), { issue: 12 }),
    ).toEqual({
      ok: false,
      problems: ["Check the branch name: Use a list or a string as the first argument of contains"],
    });
  });
});
