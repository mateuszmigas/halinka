import { describe, expect, it } from "vitest";

import { failureText, RunRefusal, ServiceError } from "./serviceError";

describe("failureText", () => {
  it("gives the note of a refusal of a run", () => {
    const error = new RunRefusal("CONFLICT", "The branch fix/title", { recordReason: "No text" });

    expect(failureText(error)).toBe("No text");
  });

  it("gives the message of another refusal", () => {
    expect(failureText(new ServiceError("CONFLICT", "Refused"))).toBe("Refused");
  });

  it("gives no message of an unexpected error", () => {
    expect(failureText(new Error("Query with parameters"))).toBe(
      "The work failed. See the server log.",
    );
  });
});
