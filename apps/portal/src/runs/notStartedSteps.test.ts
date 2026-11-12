import { describe, expect, it } from "vitest";

import { notStartedStepsOf } from "./notStartedSteps";

describe("notStartedStepsOf", () => {
  it("lists the steps that have no step run", () => {
    const steps = [{ id: "build" }, { id: "test" }, { id: "review" }];

    const notStarted = notStartedStepsOf(steps, [{ stepId: "build" }, { stepId: "review" }]);

    expect(notStarted).toEqual([{ id: "test" }]);
  });
});
