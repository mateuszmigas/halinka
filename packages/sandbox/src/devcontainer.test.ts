import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it, vi } from "vitest";

import { isDockerAvailable, limitUpdateArgs, runLimits } from "./devcontainer";

describe("devcontainer", () => {
  it("finds Docker not available when the docker command is missing", async () => {
    const empty = await tempFolder();
    vi.stubEnv("PATH", empty);

    expect(await isDockerAvailable()).toBe(false);
  });

  it("gives the update args of the memory without swap and of the CPUs", () => {
    expect(limitUpdateArgs({ memory: 1024, cpus: 1.5 }, 8)).toEqual([
      "--memory",
      "1024",
      "--memory-swap",
      "1024",
      "--cpus",
      "1.5",
    ]);
  });

  it("gives the update args of all CPUs of the host when the runner sets no CPU limit", () => {
    expect(limitUpdateArgs({ memory: 1024 }, 8)).toEqual([
      "--memory",
      "1024",
      "--memory-swap",
      "1024",
      "--cpus",
      "8",
    ]);
  });

  it("gives half of the memory of the Docker host when the runner sets no memory", () => {
    expect(runLimits({}, { memory: 8000, cpus: 4 })).toEqual({ memory: 4000, cpus: undefined });
  });

  it("keeps the limits that the runner sets", () => {
    expect(runLimits({ memory: 1024, cpus: 2 }, { memory: 8000, cpus: 4 })).toEqual({
      memory: 1024,
      cpus: 2,
    });
  });
});
