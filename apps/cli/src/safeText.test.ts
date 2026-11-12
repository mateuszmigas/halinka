import { describe, expect, it } from "vitest";

import { safeText } from "./safeText";

describe("safeText", () => {
  it.each([
    ["a bare carriage return", "failed\rpassed", "failed\npassed"],
    ["a line end with a carriage return", "a\r\nb", "a\nb"],
    ["a backspace", "ab\bc", "abc"],
    ["a lone escape, as at the end of a chunk", "a\u001b", "a"],
    ["a C1 control", "a\u009b31mb", "ab"],
    ["a bidi override", "a\u202eb", "ab"],
  ])("removes %s", (_name, text, safe) => {
    expect(safeText(text)).toBe(safe);
  });

  it("keeps tabs and line ends", () => {
    expect(safeText("a\tb\n")).toBe("a\tb\n");
  });
});
