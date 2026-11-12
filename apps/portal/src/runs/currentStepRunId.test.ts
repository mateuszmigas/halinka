import { describe, expect, it } from "vitest";

import { currentStepRunIdOf } from "./currentStepRunId";

describe("currentStepRunIdOf", () => {
  it("gives the step run that takes a message", () => {
    const stepRuns = [
      { id: 1, status: "running" as const },
      { id: 2, status: "running" as const },
    ];

    expect(currentStepRunIdOf({ stepRuns, messageTarget: { stepRunId: 1 } })).toBe(1);
  });

  it("gives the last running step run, which is the step in a loop", () => {
    const stepRuns = [
      { id: 1, status: "running" as const },
      { id: 2, status: "running" as const },
      { id: 3, status: "succeeded" as const },
    ];

    expect(currentStepRunIdOf({ stepRuns })).toBe(2);
  });

  it("gives a failed loop after its children that succeeded", () => {
    const stepRuns = [
      { id: 1, status: "failed" as const },
      { id: 2, status: "succeeded" as const },
    ];

    expect(currentStepRunIdOf({ stepRuns })).toBe(1);
  });

  it("gives the last step run that is not superseded when no step run is running", () => {
    const stepRuns = [
      { id: 1, status: "succeeded" as const },
      { id: 2, status: "skipped" as const },
      { id: 3, status: "superseded" as const },
    ];

    expect(currentStepRunIdOf({ stepRuns })).toBe(2);
  });

  it("gives no step run before the run starts one", () => {
    expect(currentStepRunIdOf({ stepRuns: [] })).toBeUndefined();
  });
});
