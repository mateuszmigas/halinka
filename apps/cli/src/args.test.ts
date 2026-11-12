import { describe, expect, it } from "vitest";

import {
  parseCommandArgs,
  parseCommandWithPositionals,
  parseCapacity,
  parseFeaturePublishers,
  parseLimits,
  parseReach,
} from "./args";
import { exitOf } from "./testing";

const refuses = (parse: () => unknown, message: string) => {
  const { code, log } = exitOf(parse);

  expect(code).toBe(1);
  expect(log).toHaveBeenCalledWith(`${message}\n\nusage`);
};

describe("args", () => {
  it("parses a whole number of 1 or more", () => {
    expect(parseCapacity("4", "usage")).toBe(4);
  });

  it.each(["0", "1.5", "x"])("refuses the capacity %s", (value) => {
    refuses(
      () => parseCapacity(value, "usage"),
      `--capacity must be a whole number of 1 or more. Got "${value}".`,
    );
  });

  it("parses addresses and CIDR ranges of IPv4 and IPv6", () => {
    const values = ["192.168.1.20", "10.0.0.0/8", "fd00::/8", "::ffff:10.0.0.0/104", "0.0.0.0/0"];

    expect(parseReach(values, "usage")).toEqual(values);
  });

  it.each(["lan.local", "10.0.0.0/33", "fd00::/129", "10.0.0.0/x", "10.0.0.0/8/1", "10.0.0.0/"])(
    "refuses the reach %s",
    (value) => {
      refuses(
        () => parseReach(["10.0.0.1", value], "usage"),
        `--reach must be an IP address or a CIDR range. Got "${value}".`,
      );
    },
  );

  it("refuses a positional argument", () => {
    const { code, log } = exitOf(() => parseCommandArgs(["extra"], {}, "usage"));

    expect(code).toBe(1);
    expect(log.mock.calls[0]?.[0]).toContain("extra");
  });

  it("gives the positional arguments and the flags", () => {
    const parsed = parseCommandWithPositionals(
      ["build", "--repo", "app"],
      { repo: { type: "string" } },
      "usage",
    );

    expect(parsed.positionals).toEqual(["build"]);
    expect(parsed.values.repo).toBe("app");
  });

  it("leaves the memory and the CPUs to the sandbox by default", () => {
    expect(parseLimits({}, "usage")).toEqual({ memory: undefined, cpus: undefined });
  });

  it.each([
    ["8g", 8 * 1024 ** 3],
    ["512M", 512 * 1024 ** 2],
    ["1.5g", 1.5 * 1024 ** 3],
    ["6291456", 6 * 1024 ** 2],
  ])("reads the memory %s", (memory, bytes) => {
    expect(parseLimits({ memory }, "usage").memory).toBe(bytes);
  });

  it("parses a CPU limit that is not a whole number", () => {
    expect(parseLimits({ cpus: "0.5" }, "usage").cpus).toBe(0.5);
  });

  it.each(["5m", "8gb", "g", "-1g", "8 g", "", "9".repeat(309), "99999999999g"])(
    "refuses the memory %s",
    (memory) => {
      refuses(
        () => parseLimits({ memory }, "usage"),
        `--memory must be a size of 6m or more, such as 8g. Got "${memory}".`,
      );
    },
  );

  it.each(["0", "0.005", "-1", "two", "Infinity"])("refuses the CPU limit %s", (cpus) => {
    refuses(
      () => parseLimits({ cpus }, "usage"),
      `--cpus must be a number of 0.01 or more, such as 2. Got "${cpus}".`,
    );
  });

  it("parses the publishers in lowercase", () => {
    expect(parseFeaturePublishers(["GHCR.io/Acme/features/"], "usage")).toEqual([
      "ghcr.io/acme/features/",
    ]);
  });

  it("refuses a value that is not a publisher", () => {
    refuses(
      () => parseFeaturePublishers(["ghcr.io/acme/features/", "localhost:5000/acme/"], "usage"),
      '--trust-features must be a registry with a dot in its name and a path that ends in /, not on the runner host, such as ghcr.io/acme/features/. Got "localhost:5000/acme/".',
    );
  });
});
