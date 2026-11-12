import { describe, expect, it } from "vitest";

import { groupStepRuns } from "./groupStepRuns";

const stepRun = (id: number, parent?: { stepRunId: number; iteration: number }) => ({
  id,
  parentStepRunId: parent?.stepRunId,
  iteration: parent?.iteration,
});

describe("groupStepRuns", () => {
  it("puts the children of a loop under the loop, grouped by iteration", () => {
    const loop = stepRun(2);
    const children = [
      stepRun(3, { stepRunId: 2, iteration: 1 }),
      stepRun(4, { stepRunId: 2, iteration: 1 }),
      stepRun(5, { stepRunId: 2, iteration: 2 }),
    ];

    expect(groupStepRuns([stepRun(1), loop, ...children, stepRun(6)])).toEqual([
      { stepRun: stepRun(1), iterations: [] },
      {
        stepRun: loop,
        iterations: [
          { iteration: 1, stepRuns: [children[0], children[1]] },
          { iteration: 2, stepRuns: [children[2]] },
        ],
      },
      { stepRun: stepRun(6), iterations: [] },
    ]);
  });
});
