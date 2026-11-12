import type { RunnerCommands } from "@halinka/protocol";
import { describe, expect, it, vi } from "vitest";

import { createWakeRunner } from "./connectedRunners";
import type { Repositories } from "./db/repositories";

const wakeable = () => ({ wake: vi.fn(async () => {}) });

const wakeWith = async (runnerId: number | undefined) => {
  const processes = new Map([
    [1, [wakeable(), wakeable()]],
    [2, [wakeable()]],
  ]);
  const repositories = {
    workflowRun: { findRunnerId: async () => runnerId },
  } as unknown as Repositories;
  const wake = createWakeRunner(repositories, {
    commandsOf: (id) => (processes.get(id) ?? []) as unknown as RunnerCommands[],
    listIds: () => [...processes.keys()],
    close: () => {},
  });
  await wake(5);
  return processes;
};

const wakesOf = (processes: Awaited<ReturnType<typeof wakeWith>>) =>
  [...processes.values()].flat().map(({ wake }) => wake.mock.calls.length);

describe("createWakeRunner", () => {
  it("wakes each process of the runner of the run", async () => {
    expect(wakesOf(await wakeWith(1))).toEqual([1, 1, 0]);
  });

  it("wakes each process of each runner for a run with no runner", async () => {
    expect(wakesOf(await wakeWith(undefined))).toEqual([1, 1, 1]);
  });
});
