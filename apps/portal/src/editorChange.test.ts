import { describe, expect, it } from "vitest";

import { editorChange } from "./editorChange";

describe("editorChange", () => {
  it("returns no edit for unchanged text", () => {
    expect(editorChange("steps: []", "steps: []")).toBeUndefined();
  });

  it("replaces only the changed text", () => {
    expect(editorChange("run: pnpm test\ntimeout: 5m", "run: pnpm build\ntimeout: 5m")).toEqual({
      start: 10,
      end: 14,
      text: "build",
    });
  });

  it.each([
    ["", "name: Build"],
    ["name: Build", ""],
    ["steps: []", "steps: [one]"],
    ["prompt: 🚀", "prompt: 🚁"],
    ["first\r\nsecond", "first\nsecond"],
    ["first\r\nsecond", "first\r\nnew\r\nsecond"],
  ])("reconstructs the replacement for %j", (before, after) => {
    const change = editorChange(before, after)!;

    expect(before.slice(0, change.start) + change.text + before.slice(change.end)).toBe(after);
  });

  it("keeps a surrogate pair in one edit", () => {
    expect(editorChange("a🚀z", "a🚁z")).toEqual({ start: 1, end: 3, text: "🚁" });
  });

  it("keeps a CRLF pair in one edit", () => {
    expect(editorChange("a\r\nb", "a\nb")).toEqual({ start: 1, end: 3, text: "\n" });
  });
});
