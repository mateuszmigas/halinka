import { protocolVersion } from "@halinka/protocol";
import { vi } from "vitest";

export const testComposeVersion = 1;

export const stubNpmRegistry = (
  answer: () => Response = () =>
    Response.json({ version: "9.0.0", protocolVersion, composeVersion: testComposeVersion }),
) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => answer());
  vi.stubGlobal("fetch", fetch);
  return fetch;
};
