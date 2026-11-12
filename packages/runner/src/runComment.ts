import type { RunComment } from "@halinka/engine";
import { type ClaimedRun, type ControlPlane, fencedText } from "@halinka/protocol";

import type { BranchPusher } from "./branchPusher";

export const runComment =
  (
    pusher: Pick<BranchPusher, "postComment">,
    plane: Pick<ControlPlane, "readCommentAccess" | "storeComment">,
    { lease }: ClaimedRun,
  ) =>
  async ({ stepRunId, stepId, body }: RunComment, signal: AbortSignal) => {
    const access = await plane.readCommentAccess(lease, stepRunId);
    if ("url" in access) return { url: access.url };
    const heading = `Halinka run ${lease.workflowRunId}, step \`${stepId}\``;
    const answer = await pusher.postComment(access, fencedText(heading, body), signal);
    if ("url" in answer) await plane.storeComment(lease, stepRunId, answer.url);
    return answer;
  };

export const madeUpComment = async ({ stepRunId }: RunComment) => ({
  url: `https://dry-run.invalid/comment/${stepRunId}`,
});
