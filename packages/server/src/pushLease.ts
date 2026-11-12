import { lastApprovalReviews, staleReview } from "@halinka/protocol";

import type { Repositories, RunWithRepo } from "./db/repositories";
import type { LeaseWrite } from "./db/repositories/pushedBranchRepository";

export const nothingToPushReason = (workflowRunId: number) =>
  `Run ${workflowRunId} changed nothing to push`;

// "Open PR" and an `open_pull_request` step: the reviewers of the last approval saw the commit.
export const findStaleReview = async (
  { stepRun }: Repositories,
  { id, workflow }: Pick<RunWithRepo, "id" | "workflow">,
  commit: string,
) => staleReview(lastApprovalReviews(workflow, await stepRun.listRecorded(id)), commit);

type StorePushOptions = { repoId: number; branch: string; write: LeaseWrite };

// Stores the write, or gives the text of a refusal.
export const storePush = async (
  { repo, pushedBranch }: Repositories,
  { repoId, branch, write }: StorePushOptions,
) => {
  // A repo delete does not wait for the run's row lock.
  if (!(await repo.lockById(repoId, "share"))) {
    return `The repo of the branch ${branch} was deleted during the push.`;
  }
  if (await pushedBranch.save(repoId, branch, write)) return undefined;
  return `Another push of the branch ${branch} stored its commit first. Check the branch on GitHub.`;
};
