import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { schemaVersion } from "./schemaVersion";
import { parseWorkflow, workflowSchema } from "./workflow";

// A run of an older `schemaVersion` fails at the claim, so only the current version needs its fixtures.
const fixturesFolder = new URL(`./resolvedFixtures/${schemaVersion}/`, import.meta.url);

const fixtures = readdirSync(fixturesFolder)
  .sort((a, b) => Number.parseInt(a) - Number.parseInt(b))
  .map((name) => ({
    name,
    resolved: JSON.parse(readFileSync(new URL(name, fixturesFolder), "utf8")) as unknown,
  }));

const referenceSource = readFileSync(
  new URL("../../../docs/examples/reference.yml", import.meta.url),
  "utf8",
);

// A run uses the stored `resolved` without a parse.
describe("workflowSchema", () => {
  // When it fails, raise `schemaVersion` and start its folder.
  it.each(fixtures)("reads $name as it was stored", ({ resolved }) => {
    expect(workflowSchema.parse(resolved)).toEqual(resolved);
  });

  // When it fails, add the next fixture; for new values with the same keys, update the newest one.
  it("has the shape of the newest fixture", () => {
    const parsed = parseWorkflow(referenceSource);

    expect(parsed).toEqual({ ok: true, value: fixtures.at(-1)!.resolved });
  });
});
