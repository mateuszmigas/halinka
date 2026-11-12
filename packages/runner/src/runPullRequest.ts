import type { RunPullRequest } from "@halinka/engine";
import type { ClaimedRun, ControlPlane } from "@halinka/protocol";

import type { BranchPusher } from "./branchPusher";

export const runPullRequest =
  (
    pusher: Pick<BranchPusher, "openPullRequestInRun">,
    plane: Pick<ControlPlane, "readPushAccess" | "storePushedBranch">,
    run: ClaimedRun,
  ) =>
  async ({ stepRunId, title, body }: RunPullRequest, signal: AbortSignal) => {
    const { lease, branch, baseSha, githubRepoId, repoPath } = run;
    const { commit, github, pushedCommit } = await plane.readPushAccess(lease, stepRunId);
    const place = githubRepoId === undefined ? { repoPath } : { githubRepoId };
    const input = {
      ...place,
      workflowRunId: lease.workflowRunId,
      branch,
      baseSha,
      commit,
      pushedCommit,
      github,
      title,
      body,
    };
    const answer = await pusher.openPullRequestInRun(input, signal, () =>
      plane.storePushedBranch(lease, stepRunId, { expected: pushedCommit }),
    );
    if ("url" in answer) {
      await plane.storePushedBranch(lease, stepRunId, {
        expected: commit,
        pullRequestUrl: answer.url,
      });
    }
    return answer;
  };

// A test run has no GitHub write: no token, no push, and no call.
export const madeUpPullRequest = async ({ stepRunId }: RunPullRequest) => ({
  url: `https://dry-run.invalid/pull/${stepRunId}`,
  isCreated: true,
});
