import { describe, expect, it } from "vitest";

import { innerRangeProblem } from "./dockerInside";

describe("innerRangeProblem", () => {
  it.each([
    ["a network inside the range", "100.64.3.2", 24],
    ["a network that holds the range", "100.1.0.2", 8],
  ])("refuses %s", (_, IPAddress, IPPrefixLen) => {
    expect(innerRangeProblem({ run: { IPAddress, IPPrefixLen } })).toContain(
      `The network run (${IPAddress}/${IPPrefixLen}) of the container overlaps 100.64.0.0/15`,
    );
  });

  it("allows a network outside the range", () => {
    expect(innerRangeProblem({ run: { IPAddress: "172.18.0.2", IPPrefixLen: 16 } })).toBe(
      undefined,
    );
  });
});
