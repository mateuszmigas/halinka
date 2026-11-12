import { describe, expect, it, vi } from "vitest";

import { defaultLeaseTimes, leaseTimesFromEnv } from "./leaseTimes";

describe("leaseTimesFromEnv", () => {
  it("uses the default times without the environment variables", () => {
    vi.stubEnv("HALINKA_LEASE_SECONDS", undefined);
    vi.stubEnv("HALINKA_SWEEP_SECONDS", undefined);

    expect(leaseTimesFromEnv()).toEqual(defaultLeaseTimes);
  });

  it("reads the times in seconds from the environment variables", () => {
    vi.stubEnv("HALINKA_LEASE_SECONDS", "10");
    vi.stubEnv("HALINKA_SWEEP_SECONDS", "0.5");

    expect(leaseTimesFromEnv()).toEqual({ leaseSeconds: 10, sweepMs: 500 });
  });

  it.each(["0", "-1", "abc", "Infinity", "86401"])("refuses the time %s", (value) => {
    vi.stubEnv("HALINKA_SWEEP_SECONDS", value);

    expect(() => leaseTimesFromEnv()).toThrow(
      `HALINKA_SWEEP_SECONDS must be a number of seconds above 0, at most 86400. Got "${value}".`,
    );
  });
});
