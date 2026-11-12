import type { ApiOutputs } from "@halinka/server/client";
import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { api } from "../api";
import { formatCost } from "../formatCost";
import { Panel } from "../panel";
import { PanelEmpty } from "../panelEmpty";

type Runner = ApiOutputs["runners"]["list"][number];
type Repo = ApiOutputs["repos"]["list"][number];

const linkClass = "text-link hover:underline";

type Tile = { label: string; value: string; className?: string };

const countText = (count: number | undefined) => (count === undefined ? "–" : String(count));

export type TotalsPanelProps = {
  totals: Pick<ApiOutputs["runs"]["totals"], "days" | "runs" | "succeeded" | "failed"> | undefined;
  costUsd: number | undefined;
};

export const TotalsPanel = (props: TotalsPanelProps) => {
  const { totals, costUsd } = props;
  const tiles: Tile[] = [
    { label: "Runs", value: countText(totals?.runs) },
    { label: "Succeeded", value: countText(totals?.succeeded) },
    {
      label: "Failed",
      value: countText(totals?.failed),
      className: (totals?.failed ?? 0) > 0 ? "text-destructive" : undefined,
    },
    { label: "Cost", value: costUsd === undefined ? "–" : formatCost(costUsd) },
  ];

  return (
    <Panel
      title={totals ? `Last ${totals.days} days` : "Totals"}
      action={
        <Link to="/costs" className={linkClass}>
          Costs
        </Link>
      }
    >
      <dl className="grid grid-cols-2 gap-px bg-border">
        {tiles.map(({ label, value, className }) => (
          <div key={label} className="flex flex-col gap-0.5 bg-card px-4 py-3">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={`text-xl font-semibold ${className ?? ""}`}>{value}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
};

const runnerActivity = ({ state, isConnected, heldRunIds }: Runner) => {
  if (!isConnected) return "offline";
  if (state === "draining") return "draining";
  if (heldRunIds.length === 0) return "no active run";
  return heldRunIds.length === 1 ? "1 run active" : `${heldRunIds.length} runs active`;
};

export type RunnersPanelProps = { runners: Runner[] };

export const RunnersPanel = (props: RunnersPanelProps) => {
  const { runners } = props;

  return (
    <Panel
      title="Runners"
      count={runners.length}
      action={
        <Link to="/runners" className={linkClass}>
          Manage
        </Link>
      }
    >
      {runners.length === 0 ? (
        <PanelEmpty>No runner.</PanelEmpty>
      ) : (
        <ul className="divide-y">
          {runners.map((runner) => (
            <li key={runner.id} className="flex items-center gap-2 px-4 py-3">
              <span
                aria-hidden
                className={`size-2 shrink-0 rounded-full ${runner.isConnected ? "bg-success" : "bg-muted-foreground/40"}`}
              />
              <span className="truncate font-medium">{runner.name}</span>
              <span className="ml-auto text-muted-foreground">{runnerActivity(runner)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
};

type Problem = { key: string; text: string; link: ReactNode };

const useSetupProblems = (repos: Repo[], runners: Runner[]) => {
  const workflows = useQueries({
    queries: repos.map((repo) => api.repos.workflows.queryOptions({ input: { id: repo.id } })),
  });
  const problems: Problem[] = [];

  if (repos.length === 0) {
    problems.push({
      key: "repos",
      text: "No repo is added.",
      link: (
        <Link to="/repos" className={linkClass}>
          Add a repo
        </Link>
      ),
    });
  }
  if (!runners.some(({ isConnected }) => isConnected)) {
    problems.push({
      key: "runners",
      text: runners.length === 0 ? "No runner is added." : "No runner is connected.",
      link: (
        <Link to="/runners" className={linkClass}>
          Show the runners
        </Link>
      ),
    });
  }
  repos.forEach((repo, index) => {
    const data = workflows[index]?.data;
    const invalid = data?.workflows.filter(({ problems }) => problems.length > 0).length ?? 0;
    const texts = [
      ...(data?.configProblems.length ? [`.halinka/config.yml in ${repo.name} is not valid.`] : []),
      ...(invalid === 1 ? [`1 workflow in ${repo.name} is not valid.`] : []),
      ...(invalid > 1 ? [`${invalid} workflows in ${repo.name} are not valid.`] : []),
    ];
    if (texts.length === 0) return;
    problems.push({
      key: `repo-${repo.id}`,
      text: texts.join(" "),
      link: (
        <Link to="/repos/$repoId" params={{ repoId: repo.id }} className={linkClass}>
          Show the problems
        </Link>
      ),
    });
  });

  return problems;
};

export type SetupProblemsProps = { repos: Repo[]; runners: Runner[] };

export const SetupProblems = (props: SetupProblemsProps) => {
  const { repos, runners } = props;
  const problems = useSetupProblems(repos, runners);

  if (problems.length === 0) return null;

  return (
    <Panel title="Setup problems" isDestructive>
      <ul className="divide-y">
        {problems.map(({ key, text, link }) => (
          <li key={key} className="flex flex-col gap-0.5 px-4 py-3">
            <span>{text}</span>
            {link}
          </li>
        ))}
      </ul>
    </Panel>
  );
};
