import { pullRequestText } from "@halinka/protocol";
import type { GitHubStep } from "@halinka/workflow";

import type { LoopBudget } from "./limits";
import { type AttemptBodyResult, runAttempts, singleAttempt, type StepRun } from "./runAttempts";
import type { StepContext } from "./runDeps";
import { stepTimeLimit, withinTimeLimit } from "./timeLimit";

type GitHubStepRun = { step: GitHubStep; stepRun: StepRun; loop?: LoopBudget };

const defaultGitHubTimeout = "10m";

export const executeGitHubStep = (context: StepContext, { step, stepRun, loop }: GitHubStepRun) =>
  runAttempts(
    context,
    { stepId: step.id, stepRun, policy: singleAttempt },
    async (_attempt, signal) => {
      const { lease, workflowName, deps } = context;
      const { stepRunId } = stepRun;
      const started = Date.now();
      const usage = () => ({ activeMs: Date.now() - started });
      return withinTimeLimit<AttemptBodyResult>(
        stepTimeLimit(step.timeout ?? defaultGitHubTimeout, loop),
        {
          action: async (within) => {
            if (step.action === "comment_on_pull_request") {
              const comment = await deps.repoSource.commentOnPullRequest(
                { stepRunId, stepId: step.id, body: step.body ?? "" },
                within,
              );
              return "error" in comment
                ? { status: "failed", summary: comment.error, usage: usage() }
                : {
                    status: "succeeded",
                    summary: `The comment is on the pull request: ${comment.url}`,
                    outputs: { comment_url: comment.url },
                    usage: usage(),
                  };
            }
            const closes = step.closes === undefined ? undefined : Number(step.closes);
            if (closes !== undefined && !(Number.isSafeInteger(closes) && closes > 0)) {
              const summary = `closes gives "${step.closes}", which is not an issue number`;
              return { status: "failed", summary, usage: usage() };
            }
            const text = { title: step.title, body: step.body, closes };
            const answer = await deps.repoSource.openPullRequest(
              { stepRunId, ...pullRequestText(lease.workflowRunId, workflowName, text) },
              within,
            );
            if ("error" in answer) {
              return { status: "failed", summary: answer.error, usage: usage() };
            }
            const opened = answer.isCreated ? "open" : "already open";
            return {
              status: "succeeded",
              summary: `The pull request is ${opened}: ${answer.url}`,
              outputs: { pull_request_url: answer.url },
              usage: usage(),
            };
          },
          atLimit: ({ message }) => ({ status: "failed", summary: message, usage: usage() }),
        },
        signal,
      );
    },
  );
