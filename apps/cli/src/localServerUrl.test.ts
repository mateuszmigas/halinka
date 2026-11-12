import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it, vi } from "vitest";

import { readLocalServerUrl } from "./localServerUrl";

const setUp = async () => {
  const home = await tempFolder();
  vi.stubEnv("HALINKA_HOME", home);
  return { home };
};

describe("readLocalServerUrl", () => {
  it("gives the default URL without the file", async () => {
    await setUp();

    await expect(readLocalServerUrl()).resolves.toBe("http://127.0.0.1:7070");
  });

  it("gives the URL in the file", async () => {
    const { home } = await setUp();
    await writeFile(join(home, "server.json"), '{"url":"http://127.0.0.1:8080"}');

    await expect(readLocalServerUrl()).resolves.toBe("http://127.0.0.1:8080");
  });

  it.each(["{", "{}", '{"url":1}', "null"])("refuses the file content %s", async (content) => {
    const { home } = await setUp();
    await writeFile(join(home, "server.json"), content);

    await expect(readLocalServerUrl()).rejects.toThrow("has no server URL");
  });
});
