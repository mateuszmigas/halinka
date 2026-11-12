import { describe, expect, it } from "vitest";

import { resolveInputs, type WorkflowInput } from "./inputs";

const declared: Record<string, WorkflowInput> = {
  issue: { type: "number", required: true },
  draft: { type: "boolean", default: false },
  title: { default: "Fix" },
  note: {},
};

const problemsOf = (given: Record<string, string | number | boolean>) => {
  const result = resolveInputs(declared, { issue: 12, ...given });
  return result.ok ? [] : result.problems;
};

describe("resolveInputs", () => {
  it("converts the text of a form to the declared types", () => {
    expect(resolveInputs(declared, { issue: " -1.5 ", draft: "true", title: "Fix it" })).toEqual({
      ok: true,
      value: { issue: -1.5, draft: true, title: "Fix it" },
    });
    expect(resolveInputs(declared, { issue: 12, draft: "false" })).toMatchObject({
      value: { draft: false },
    });
  });

  it("applies the defaults to inputs without a value or with empty text", () => {
    expect(resolveInputs(declared, { issue: 12, title: "" })).toEqual({
      ok: true,
      value: { issue: 12, draft: false, title: "Fix" },
    });
  });

  it("refuses an input that the workflow does not declare", () => {
    expect(problemsOf({ branch: "main" })).toEqual([
      { name: "branch", message: "The workflow has no such input" },
    ]);
  });

  it.each([undefined, ""])("refuses a required input given %j", (issue) => {
    expect(resolveInputs(declared, issue === undefined ? {} : { issue })).toEqual({
      ok: false,
      problems: [{ name: "issue", message: "Give a value" }],
    });
  });

  it.each([
    ["draft", "yes", "Use true or false"],
    ["title", 3, "Use text"],
    ["issue", " ", "Use a number"],
    ["issue", "1e400", "Use a number"],
    ["issue", "12abc", "Use a number"],
    ["issue", "0x10", "Use a number"],
    ["issue", "9".repeat(400), "Use a number"],
  ])("refuses %s given %j", (name, value, message) => {
    expect(problemsOf({ [name]: value })).toEqual([{ name, message }]);
  });
});
