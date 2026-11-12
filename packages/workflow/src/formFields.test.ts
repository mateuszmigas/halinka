import { describe, expect, it } from "vitest";

import { formFieldsOf } from "./formFields";

const fieldOf = (type: string, name: string) =>
  formFieldsOf(type)?.find((field) => field.name === name);

describe("formFieldsOf", () => {
  it("shows the action of a github step with the actions of the schema", () => {
    expect(fieldOf("github", "action")).toEqual({
      name: "action",
      isOptional: false,
      isNumeric: false,
      options: ["open_pull_request", "comment_on_pull_request"],
    });
  });

  it("takes an optional number field from the schema", () => {
    expect(fieldOf("agent", "max_cost_usd")).toMatchObject({ isOptional: true, isNumeric: true });
  });

  it("takes a required whole number field from the schema", () => {
    expect(fieldOf("loop", "max_iterations")).toMatchObject({ isOptional: false, isNumeric: true });
  });

  it("shows no on_exhausted for a loop", () => {
    expect(fieldOf("loop", "on_exhausted")).toBeUndefined();
  });

  it("gives no fields for a type that the form does not edit", () => {
    expect(formFieldsOf("toString")).toBeUndefined();
  });
});
