import { parseWorkflow, type Workflow } from "@halinka/workflow";
import { describe, expect, it } from "vitest";

import type { RecordedStep } from "./controlPlane";
import { lastApprovalReviews } from "./reviews";

const workflowOf = (source: string) => {
  const parsed = parseWorkflow(source);
  if (!parsed.ok) throw new Error("The test workflow is not valid");
  return parsed.value as Workflow;
};

const workflow = workflowOf(
  [
    "schema_version: 1",
    "name: Ship",
    "steps:",
    "  - { id: first, type: agent, agent: claude-code, permissions: { write: false }, prompt: Review }",
    "  - { id: ok1, type: approval, message: One, reviewers: [first] }",
    "  - { id: second, type: agent, agent: claude-code, permissions: { write: false }, prompt: Review }",
    "  - { id: ok2, type: approval, message: Two, reviewers: [second] }",
  ].join("\n"),
);

const recordedOf = (steps: [string, string?, RecordedStep["status"]?][]): RecordedStep[] =>
  steps.map(([stepId, commit, status = "succeeded"], index) => ({
    stepRunId: index + 1,
    stepId,
    status,
    failedAttempts: 0,
    ...(commit && { commit }),
  }));

describe("lastApprovalReviews", () => {
  it("gives the reviews of the reviewers of the last approval only", () => {
    const recorded = recordedOf([["first", "a"], ["ok1"], ["second", "b"], ["ok2"]]);

    expect(lastApprovalReviews(workflow, recorded)).toEqual([{ stepId: "second", commit: "b" }]);
  });

  it("leaves out an approval that was skipped", () => {
    const recorded = recordedOf([
      ["first", "a"],
      ["ok1"],
      ["second", undefined, "skipped"],
      ["ok2", undefined, "skipped"],
    ]);

    expect(lastApprovalReviews(workflow, recorded)).toEqual([{ stepId: "first", commit: "a" }]);
  });

  it("gives no reviews for a run without an approval", () => {
    expect(lastApprovalReviews(workflow, recordedOf([["first", "a"]]))).toEqual([]);
  });
});
