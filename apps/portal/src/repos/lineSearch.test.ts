import { describe, expect, it } from "vitest";

import { parseLineSearch } from "./lineSearch";

describe("parseLineSearch", () => {
  it("keeps a positive whole line", () => {
    expect(parseLineSearch({ line: 12 })).toEqual({ line: 12 });
  });

  it.each([0, -1, 1.5, "12", undefined])("drops the line %s", (line) => {
    expect(parseLineSearch({ line })).toEqual({});
  });
});
