import type { ApiOutputs } from "@halinka/server/client";
import { shortSha } from "@halinka/utils/git";
import type { ReactNode } from "react";

import { formatCost } from "../formatCost";
import { formatDateTime } from "../formatDateTime";
import { OpenInVsCodeButton } from "./openInVsCodeButton";
import { OpenOverSshButton } from "./openOverSshButton";
import { RunActionButton } from "./runActionButton";
import { workspaceLabel } from "./workspaceLabel";

type FactProps = { label: string; children: ReactNode };

const Fact = (props: FactProps) => {
  const { label, children } = props;

  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
};

export type RunFactsProps = { run: ApiOutputs["runs"]["get"] };

export const RunFacts = (props: RunFactsProps) => {
  const { run } = props;
  const { sandbox } = run;
  const workspace = workspaceLabel(sandbox);
  const costs = run.stepRuns.flatMap(({ usage }) => (usage ? [usage.costUsd] : []));

  return (
    <dl className="flex flex-col gap-3">
      <Fact label="Repo">{run.repoName}</Fact>
      <Fact label="Branch">
        <span className="font-mono break-all">{run.branch}</span>
      </Fact>
      <Fact label="Base">
        <span className="font-mono">{shortSha(run.baseSha)}</span>
      </Fact>
      {run.pushedCommit && (
        <Fact label="Pushed">
          <span className="font-mono">{shortSha(run.pushedCommit)}</span>
        </Fact>
      )}
      {run.pullRequestUrl && (
        <Fact label="Pull request">
          <a
            href={run.pullRequestUrl}
            target="_blank"
            rel="noreferrer"
            className="break-all underline"
          >
            {run.pullRequestUrl}
          </a>
        </Fact>
      )}
      {run.waitReason && <Fact label="Waits">{run.waitReason}</Fact>}
      {costs.length > 0 && (
        <Fact label="Cost">{formatCost(costs.reduce((sum, cost) => sum + cost, 0))}</Fact>
      )}
      <Fact label="Created">{formatDateTime(run.createdAt)}</Fact>
      {run.startedAt && <Fact label="Started">{formatDateTime(run.startedAt)}</Fact>}
      {run.finishedAt && <Fact label="Finished">{formatDateTime(run.finishedAt)}</Fact>}
      {run.cancelRequestedAt && (
        <Fact label="Cancel requested">{formatDateTime(run.cancelRequestedAt)}</Fact>
      )}
      {(workspace || run.canStartSandbox) && (
        <Fact label="Workspace">
          <div className="flex flex-col items-start gap-2">
            {workspace}
            {run.canStartSandbox && (
              <RunActionButton action="startContainer" workflowRunId={run.id} />
            )}
            {sandbox?.attach && <OpenInVsCodeButton attach={sandbox.attach} />}
            {sandbox?.sshFolder && (
              <OpenOverSshButton workflowRunId={run.id} folder={sandbox.sshFolder} />
            )}
            {run.canStopSandbox && (
              <RunActionButton action="stopContainer" workflowRunId={run.id} />
            )}
            {run.canRemoveSandbox && (
              <RunActionButton action="removeWorkspace" workflowRunId={run.id} />
            )}
          </div>
        </Fact>
      )}
    </dl>
  );
};
