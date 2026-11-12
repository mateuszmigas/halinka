import { describe, expect, it } from "vitest";

import { durationMs, durationSchema } from "./duration";

describe("duration", () => {
  it.each([
    ["30s", 30_000],
    ["45m", 2_700_000],
    ["2h", 7_200_000],
  ])("gives %s in milliseconds", (text, ms) => {
    expect(durationMs(text)).toBe(ms);
  });

  it.each(["0m", "1.5h", "10", "5 m", "1d", "597h"])("refuses %s", (text) => {
    expect(durationSchema.safeParse(text).success).toBe(false);
  });
});
