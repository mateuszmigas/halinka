import { describe, expect, it } from "vitest";

import { outcomeResult, reportSchema } from "./stepReport";

const accepts = (step: Parameters<typeof reportSchema>[0], report: unknown) =>
  reportSchema(step).safeParse(report).success;

describe("stepReport", () => {
  it("accepts a report with only a summary", () => {
    expect(accepts({}, { summary: "Done" })).toBe(true);
  });

  it("refuses an empty summary", () => {
    expect(accepts({}, { summary: "" })).toBe(false);
  });

  it("refuses an outcome when the step declares none", () => {
    expect(accepts({}, { summary: "Done", outcome: "approve" })).toBe(false);
  });

  it("accepts a declared outcome", () => {
    expect(
      accepts({ outcomes: ["approve", "reject"] }, { summary: "Done", outcome: "reject" }),
    ).toBe(true);
  });

  it("refuses an outcome that the step does not declare", () => {
    expect(accepts({ outcomes: ["approve"] }, { summary: "Done", outcome: "done" })).toBe(false);
  });

  it("requires an outcome when the step declares outcomes", () => {
    expect(accepts({ outcomes: ["approve"] }, { summary: "Done" })).toBe(false);
  });

  it("takes the outcome names from the keys of an outcome map", () => {
    const outcomes = { done: "ok", blocked: "fail" } as const;

    expect(accepts({ outcomes }, { summary: "Done", outcome: "blocked" })).toBe(true);
    expect(accepts({ outcomes }, { summary: "Done", outcome: "fail" })).toBe(false);
  });

  const outputs = {
    approved: "boolean",
    meta: { title: "string" },
    findings: { type: "array", items: { file: "string", line: "number" } },
  } as const;
  const valid = {
    approved: false,
    meta: { title: "Fix" },
    findings: [{ file: "a.ts", line: 3 }],
  };

  it("accepts outputs of the declared types", () => {
    expect(accepts({ outputs }, { summary: "Done", outputs: valid })).toBe(true);
  });

  it("refuses an output of another type", () => {
    expect(
      accepts(
        { outputs },
        { summary: "Done", outputs: { ...valid, findings: [{ file: "a.ts", line: "3" }] } },
      ),
    ).toBe(false);
  });

  it("refuses a missing field in a nested map", () => {
    expect(accepts({ outputs }, { summary: "Done", outputs: { ...valid, meta: {} } })).toBe(false);
  });

  it("refuses an output that the step does not declare", () => {
    expect(accepts({ outputs }, { summary: "Done", outputs: { ...valid, extra: 1 } })).toBe(false);
  });

  it("requires outputs when the step declares outputs", () => {
    expect(accepts({ outputs }, { summary: "Done" })).toBe(false);
  });

  it("gives ok for each outcome of an outcome list", () => {
    expect(outcomeResult(["approve", "reject"], "reject")).toBe("ok");
  });

  it("gives the result that an outcome map sets for the outcome", () => {
    const outcomes = { done: "ok", blocked: "fail" } as const;

    expect(outcomeResult(outcomes, "blocked")).toBe("fail");
    expect(outcomeResult(outcomes, "done")).toBe("ok");
  });

  it("gives ok for a name that only the object prototype has", () => {
    expect(outcomeResult({ blocked: "fail" }, "constructor")).toBe("ok");
  });

  it("gives ok when the step declares no outcomes or the report has no outcome", () => {
    expect(outcomeResult(undefined, "done")).toBe("ok");
    expect(outcomeResult({ blocked: "fail" }, undefined)).toBe("ok");
  });
});
