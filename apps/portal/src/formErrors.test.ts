import { ORPCError } from "@halinka/server/client";
import { describe, expect, it } from "vitest";

import { toFormErrors } from "./formErrors";

const badRequest = (issues: { path?: string[]; message: string }[]) =>
  new ORPCError("BAD_REQUEST", {
    defined: true,
    message: "Input validation failed",
    data: { issues },
  });

describe("toFormErrors", () => {
  it("gives each issue to the field that its path names", () => {
    const error = badRequest([
      { path: ["path"], message: "Use an absolute path" },
      { path: ["path"], message: "Too long" },
    ]);

    expect(toFormErrors(error, ["path"])).toEqual({
      fields: { path: [{ message: "Use an absolute path" }, { message: "Too long" }] },
    });
  });

  it("gives an issue with a nested path to the field with that dotted name", () => {
    const error = badRequest([{ path: ["inputs", "issue"], message: "Give a value" }]);

    expect(toFormErrors(error, ["inputs.issue"])).toEqual({
      fields: { "inputs.issue": [{ message: "Give a value" }] },
    });
  });

  it("gives an issue at the parent of a dotted field to the form", () => {
    const error = badRequest([{ path: ["inputs"], message: "Use an object" }]);

    expect(toFormErrors(error, ["inputs.issue"])).toEqual({
      form: [{ message: "Use an object" }],
      fields: {},
    });
  });

  it("gives the issues that name no field to the form", () => {
    const error = badRequest([
      { path: ["other"], message: "Too small" },
      { message: "Use an object" },
    ]);

    expect(toFormErrors(error, ["path"])).toEqual({
      form: [{ message: "Too small" }, { message: "Use an object" }],
      fields: {},
    });
  });

  it("gives the message of a bad request without issues to the form", () => {
    const error = new ORPCError("BAD_REQUEST", { defined: true, message: "Not a git repo" });

    expect(toFormErrors(error, ["path"])).toEqual({
      form: [{ message: "Not a git repo" }],
      fields: {},
    });
  });

  const invalidWorkflow = new ORPCError("INVALID_WORKFLOW", {
    defined: true,
    message: "Invalid workflow",
    data: {
      path: ".halinka/workflows/build.yml",
      problems: [{ line: 3, column: 5, path: ["steps"], message: "Add a step" }],
    },
  });

  it("gives the problems of an invalid workflow to the workflow field", () => {
    expect(toFormErrors(invalidWorkflow, ["repoId", "workflow"])).toEqual({
      fields: { workflow: [{ message: "Add a step", location: { line: 3, column: 5 } }] },
    });
  });

  it("gives the problems of an invalid workflow to the form when it has no workflow field", () => {
    expect(toFormErrors(invalidWorkflow, ["inputs.issue"])).toEqual({
      form: [{ message: "Add a step", location: { line: 3, column: 5 } }],
      fields: {},
    });
  });

  it("gives an error that the contract does not define to the form", () => {
    const error = new ORPCError("BAD_REQUEST", {
      message: "Bad gateway",
      data: { issues: [{ path: ["path"], message: "x" }] },
    });

    expect(toFormErrors(error, ["path"])).toEqual({
      form: [{ message: "Bad gateway" }],
      fields: {},
    });
  });
});
