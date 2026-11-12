import { leafSteps, type Workflow } from "@halinka/workflow";

import type { RecordedStep } from "./controlPlane";

// `commit`: of the last step run of the reviewer; unset when it has none
export type Review = { stepId: string; commit?: string };

export const reviewsOf = (
  reviewers: readonly string[],
  recorded: readonly RecordedStep[],
): Review[] =>
  reviewers.map((stepId) => {
    const commit = recorded.findLast((stepRun) => stepRun.stepId === stepId)?.commit;
    return { stepId, ...(commit !== undefined && { commit }) };
  });

// undefined: the reviews cover `head`.
export const staleReview = (reviews: readonly Review[], head: string) => {
  for (const { stepId, commit } of reviews) {
    if (!commit) return `The step \`${stepId}\` did not review the branch.`;
    if (commit !== head) {
      return `The step \`${stepId}\` reviewed ${commit.slice(0, 7)}, but the branch is at ${head.slice(0, 7)}.`;
    }
  }
  return undefined;
};

// The reviews of the last approval of the run that succeeded: a skipped approval checked nothing.
export const lastApprovalReviews = (workflow: Workflow, recorded: readonly RecordedStep[]) => {
  const steps = new Map(leafSteps(workflow).map((step) => [step.id, step]));
  const approval = recorded
    .filter(({ status }) => status === "succeeded")
    .map(({ stepId }) => steps.get(stepId))
    .findLast((step) => step?.type === "approval");
  return approval?.type === "approval" ? reviewsOf(approval.reviewers ?? [], recorded) : [];
};
