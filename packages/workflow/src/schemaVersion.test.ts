import { describe, expect, it } from "vitest";

import { parseRepoConfig } from "./repoConfig";
import { parseWorkflow } from "./workflow";

const olderMessage =
  "This file is from an older Halinka. Run halinka migrate --write, or click Apply fixes in the workflow editor.";

const messagesOf = (source: string) => {
  const parsed = parseWorkflow(source);
  return parsed.ok ? [] : parsed.problems.map(({ message }) => message);
};

describe("parseVersioned", () => {
  it("gives only the version problem for a file without schema_version", () => {
    expect(messagesOf("name: Build\nenvironment: default\nsteps: []\n")).toEqual([olderMessage]);
  });

  it("refuses a newer schema_version", () => {
    expect(messagesOf("schema_version: 2\nname: Build\n")).toEqual([
      "Update Halinka to read schema_version 2",
    ]);
  });

  it("refuses a schema_version that is not a whole number", () => {
    expect(messagesOf("schema_version: 1.5\nname: Build\n")).toEqual(["Use a whole number"]);
  });

  it("refuses a schema_version below 1", () => {
    expect(messagesOf("schema_version: 0\nname: Build\n")).toEqual(["Use 1 or more"]);
  });

  it("gives a parsed value without schema_version", () => {
    expect(parseRepoConfig("schema_version: 1\nserver: local\n")).toEqual({
      ok: true,
      value: { server: "local" },
    });
  });

  it("names only the command line for a config.yml without schema_version", () => {
    expect(parseRepoConfig("server: local\n")).toMatchObject({
      ok: false,
      problems: [
        {
          path: ["schema_version"],
          message:
            "This file is from an older Halinka. Run halinka migrate --write in the repo. For a GitHub repo, then commit and push the files.",
        },
      ],
    });
  });
});
