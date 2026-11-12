import { describe, expect, it } from "vitest";

import {
  connectionClosed,
  internalError,
  invalidInput,
  isTransient,
  leaseLost,
  unavailable,
} from "./errors";

describe("isTransient", () => {
  it.each([
    ["a closed connection", connectionClosed()],
    ["a server without its database", unavailable("down")],
  ])("is true for %s", (_, error) => {
    expect(isTransient(error)).toBe(true);
  });

  it.each([
    ["invalid input", invalidInput("bad")],
    ["a lost lease", leaseLost(1)],
    ["an internal error of the server", internalError("boom")],
    ["an error without a code", new Error("boom")],
  ])("is false for %s", (_, error) => {
    expect(isTransient(error)).toBe(false);
  });
});
