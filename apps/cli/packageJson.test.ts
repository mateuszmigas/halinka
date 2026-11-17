import { readFileSync } from "node:fs";

import { protocolVersion } from "@halinka/protocol";
import { hashOf } from "@halinka/utils/hash";
import { describe, expect, it } from "vitest";

import packageJson from "./package.json" with { type: "json" };

const hashOfFile = (path: string) => hashOf(readFileSync(new URL(path, import.meta.url)));

// The update banner reads `protocolVersion` and `composeVersion` of the latest version from the npm registry.
describe("the package.json of halinka", () => {
  it("states the protocol version of the code", () => {
    expect(packageJson.protocolVersion).toBe(protocolVersion);
  });

  // When the files change, raise `composeVersion` and write their new hashes here.
  it("has the Compose files of its Compose version", () => {
    expect({
      composeVersion: packageJson.composeVersion,
      compose: hashOfFile("../../infrastructure/docker-compose.yml"),
      envTemplate: hashOfFile("../../infrastructure/env.template"),
    }).toEqual({
      composeVersion: 1,
      compose: "5b49eeba1b8b686b7b51e4a0776d10d43a650cb9e764e76c693721a99a4d34d1",
      envTemplate: "9883f6884e28d62611b240a72cf2bbf7589fb9bed83afe7ae2889dc686a2219d",
    });
  });
});
