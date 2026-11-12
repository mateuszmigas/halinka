import type { ApiOutputs } from "@halinka/server/client";
import { Badge } from "@halinka/ui/components/badge";
import { Link } from "@tanstack/react-router";

import { formatDateTime } from "../formatDateTime";
import { InboxItem } from "../inbox/inboxItem";
import { Panel } from "../panel";
import { PanelEmpty } from "../panelEmpty";
import { StatusLabel } from "../runs/statusLabel";

type Run = ApiOutputs["runs"]["list"]["runs"][number];
type Item = ApiOutputs["inbox"]["list"][number];

const linkClass = "text-link hover:underline";

type RunLinkProps = { id: number; name: string };

const RunLink = (props: RunLinkProps) => {
  const { id, name } = props;

  return (
    <Link
      to="/runs/$workflowRunId"
      params={{ workflowRunId: id }}
      className={`font-medium ${linkClass}`}
    >
      #{id} {name}
    </Link>
  );
};

export type NeedsYouProps = { items: Item[] };

export const NeedsYou = (props: NeedsYouProps) => {
  const { items } = props;

  return (
    <Panel
      title="Needs you"
      count={items.length}
      action={
        <Link to="/inbox" className={linkClass}>
          Open the inbox
        </Link>
      }
    >
      {items.length === 0 ? (
        <PanelEmpty>No item waits for you.</PanelEmpty>
      ) : (
        <div className="divide-y">
          {items.map((item) => (
            <article key={item.id}>
              <header className="flex flex-wrap items-center gap-2 px-4 pt-3">
                <Badge variant={item.kind === "question" ? "default" : "warning"}>
                  {item.kind.replaceAll("_", " ")}
                </Badge>
                <RunLink id={item.workflowRunId} name={item.workflowName} />
                <span className="text-muted-foreground">{item.repoName}</span>
                <span className="font-mono text-muted-foreground">{item.stepId}</span>
                <span className="ml-auto text-muted-foreground">
                  {formatDateTime(item.createdAt)}
                </span>
              </header>
              <div className="px-4 py-3">
                <InboxItem item={item} />
              </div>
            </article>
          ))}
        </div>
      )}
    </Panel>
  );
};

export type RunningNowProps = { runs: Run[]; hasMore: boolean };

export const RunningNow = (props: RunningNowProps) => {
  const { runs, hasMore } = props;

  return (
    <Panel title="Active runs" count={runs.length}>
      {runs.length === 0 ? (
        <PanelEmpty>No run is active.</PanelEmpty>
      ) : (
        <ul className="divide-y">
          {runs.map((run) => (
            <li key={run.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <StatusLabel status={run.status} />
              <div className="flex min-w-0 flex-col">
                <RunLink id={run.id} name={run.workflowName} />
                <span className="truncate text-muted-foreground">
                  {run.repoName} · <span className="font-mono">{run.branch}</span>
                </span>
              </div>
              <span className="ml-auto text-muted-foreground">
                {run.startedAt
                  ? `Started ${formatDateTime(run.startedAt)}`
                  : `Queued ${formatDateTime(run.createdAt)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {hasMore && <PanelEmpty>Only the newest {runs.length} active runs show here.</PanelEmpty>}
    </Panel>
  );
};

export type RecentRunsProps = { runs: Run[] };

export const RecentRuns = (props: RecentRunsProps) => {
  const { runs } = props;

  return (
    <Panel
      title="Recent runs"
      action={
        <Link to="/runs" className={linkClass}>
          All runs
        </Link>
      }
    >
      {runs.length === 0 ? (
        <PanelEmpty>No run ended.</PanelEmpty>
      ) : (
        <ul className="divide-y">
          {runs.map((run) => (
            <li
              key={run.id}
              className="grid grid-cols-[6rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 md:grid-cols-[6rem_minmax(0,1fr)_minmax(0,8rem)_auto] xl:grid-cols-[6rem_minmax(0,1fr)_minmax(0,8rem)_minmax(0,10rem)_auto]"
            >
              <span>
                <StatusLabel status={run.status} />
              </span>
              <span className="truncate">
                <RunLink id={run.id} name={run.workflowName} />
              </span>
              <span className="hidden truncate text-muted-foreground md:block">{run.repoName}</span>
              <span className="hidden truncate font-mono text-muted-foreground xl:block">
                {run.branch}
              </span>
              <span className="text-right whitespace-nowrap text-muted-foreground">
                {formatDateTime(run.finishedAt ?? run.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
};
