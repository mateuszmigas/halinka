import { describe, expect, it } from "vitest";

import { shownIterationOf } from "./shownIteration";

const iterations = [
  {
    iteration: 1,
    stepRuns: [
      { id: 2, status: "succeeded" as const },
      { id: 3, status: "succeeded" as const },
    ],
  },
  { iteration: 2, stepRuns: [{ id: 4, status: "running" as const }] },
];

describe("shownIterationOf", () => {
  it("shows the newest iteration when the selection is outside the loop", () => {
    expect(shownIterationOf(iterations, 1, undefined)).toBe(2);
  });

  it("shows the iteration of the selected step run", () => {
    expect(shownIterationOf(iterations, 3, undefined)).toBe(1);
  });

  it("shows the chosen iteration over the iteration of the selection", () => {
    expect(shownIterationOf(iterations, 4, 1)).toBe(1);
  });

  it("skips a newer iteration that a reopen superseded", () => {
    const reopened = [
      iterations[0]!,
      { iteration: 2, stepRuns: [{ id: 4, status: "superseded" as const }] },
    ];

    expect(shownIterationOf(reopened, 1, undefined)).toBe(1);
  });
});
