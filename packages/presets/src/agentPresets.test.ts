import { describe, expect, it } from "vitest";

import { agentPresets, packageAt } from "./agentPresets";

const preset = { ...agentPresets.codex, package: "@scope/name", version: "1.0.0" };

describe("packageAt", () => {
  it("uses the version of the preset", () => {
    expect(packageAt(preset)).toBe("@scope/name@1.0.0");
  });

  it("uses another version in its place", () => {
    expect(packageAt(preset, "1.2.3")).toBe("@scope/name@1.2.3");
  });
});
