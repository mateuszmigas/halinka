import { type Review, staleReview } from "@halinka/protocol";
import { type ApprovalStep, approvalOutcomes } from "@halinka/workflow";

import { runAttempts, singleAttempt, type StepRun, waitForDecision, withNote } from "./runAttempts";
import type { StepContext } from "./runDeps";

// `reviews`: of the `reviewers` of the step
type ApprovalStepRun = { step: ApprovalStep; stepRun: StepRun; reviews?: readonly Review[] };

export const executeApprovalStep = (
  context: StepContext,
  { step, stepRun, reviews }: ApprovalStepRun,
) =>
  runAttempts(
    context,
    { stepId: step.id, stepRun, policy: singleAttempt },
    async (_attempt, signal) => {
      const { plane, inbox } = context.deps;
      if (reviews) {
        const stale = staleReview(reviews, await context.checkpoints.readHead());
        if (stale) return { status: "failed", summary: stale };
      }
      const itemId = await plane.openApproval(context.lease, stepRun.stepRunId, step.message);
      const { decision, note } = await waitForDecision(inbox, { kind: "approval", itemId }, signal);
      const isApproved = decision === "approve";
      const summary = withNote(undefined, isApproved ? "Approved" : "Rejected", note);
      return {
        status: isApproved ? "succeeded" : "failed",
        summary,
        outcome: approvalOutcomes[decision],
      };
    },
  );
