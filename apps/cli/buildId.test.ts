import { describe, expect, it } from "vitest";

import { buildIdOf } from "./buildId";

const fileOf = (path: string, text: string) => ({ path, content: Buffer.from(text) });

const files = [fileOf("apps/cli/dist/main.js", "main"), fileOf("apps/cli/package.json", "{}")];

describe("buildIdOf", () => {
  it("gives the same id for the same files in another order", () => {
    expect(buildIdOf(files.toReversed())).toBe(buildIdOf(files));
  });

  it("gives another id when the package.json changes", () => {
    const changed = [files[0]!, fileOf("apps/cli/package.json", '{"version":"0.0.2"}')];

    expect(buildIdOf(changed)).not.toBe(buildIdOf(files));
  });

  it("gives another id when a file moves to another path", () => {
    const moved = [fileOf("apps/cli/dist/other.js", "main"), files[1]!];

    expect(buildIdOf(moved)).not.toBe(buildIdOf(files));
  });
});
