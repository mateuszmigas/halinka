import { protocolVersion } from "@halinka/protocol";
import { describe, expect, it } from "vitest";

import packageJson from "./package.json" with { type: "json" };

// The update banner reads `protocolVersion` of the latest version from the npm registry.
describe("the package.json of halinka", () => {
  it("states the protocol version of the code", () => {
    expect(packageJson.protocolVersion).toBe(protocolVersion);
  });
});
