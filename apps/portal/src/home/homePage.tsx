import { maxRunPageSize } from "@halinka/server/client";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useMemo } from "react";

import { api } from "../api";
import { costTotals, repoOwnerOf } from "../costs/costTotals";
import { Page, PageHeader } from "../page";
import { QueryFallback } from "../queryFallback";
import { statusPollMs } from "../statusPollMs";
import { NeedsYou, RecentRuns, RunningNow } from "./homeRuns";
import { RunnersPanel, SetupProblems, TotalsPanel } from "./homeStatus";

const RunsChart = lazy(async () => ({ default: (await import("./runsChart")).RunsChart }));

const CostChart = lazy(async () => ({ default: (await import("./costChart")).CostChart }));

const recentRunCount = 5;
const totalsPollMs = 60_000;

const endOf = (run: { finishedAt?: string; createdAt: string }) =>
  Date.parse(run.finishedAt ?? run.createdAt);

const summaryOf = (items: number, activeRuns: number) => {
  const waiting =
    items === 0
      ? "No item waits for you."
      : `${items} ${items === 1 ? "item waits" : "items wait"} for you.`;
  const active =
    activeRuns === 0
      ? "No run is active."
      : `${activeRuns} ${activeRuns === 1 ? "run is" : "runs are"} active.`;
  return `${waiting} ${active}`;
};

export const HomePage = () => {
  const polled = { refetchInterval: statusPollMs };
  const items = useQuery({ ...api.inbox.list.queryOptions(), ...polled });
  const activeRuns = useQuery({
    ...api.runs.list.queryOptions({ input: { state: "active", limit: maxRunPageSize } }),
    ...polled,
  });
  const endedRuns = useQuery({
    ...api.runs.list.queryOptions({ input: { state: "ended", limit: recentRunCount } }),
    ...polled,
  });
  const totals = useQuery({ ...api.runs.totals.queryOptions(), refetchInterval: totalsPollMs });
  const runners = useQuery({ ...api.runners.list.queryOptions(), ...polled });
  const repos = useQuery(api.repos.list.queryOptions());
  const costs = useQuery(api.costs.list.queryOptions());
  const repoCosts = useMemo(
    () => costs.data && costTotals(costs.data.totals, repoOwnerOf),
    [costs.data],
  );

  if (items.data === undefined || activeRuns.data === undefined || endedRuns.data === undefined) {
    return (
      <Page>
        <PageHeader title="Home" />
        <QueryFallback error={items.error ?? activeRuns.error ?? endedRuns.error} />
      </Page>
    );
  }

  const active = activeRuns.data.runs;
  const recent = endedRuns.data.runs.toSorted((first, second) => endOf(second) - endOf(first));
  const costUsd = costs.data?.totals.reduce((sum, total) => sum + total.costUsd, 0);
  const activeRunners = runners.data?.filter(({ state }) => state !== "revoked");

  return (
    <Page>
      <PageHeader title="Home" description={summaryOf(items.data.length, active.length)} />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <NeedsYou items={items.data} />
          <RunningNow runs={active} hasMore={activeRuns.data.nextBeforeId !== undefined} />
          {totals.data && (
            <Suspense>
              <RunsChart perDay={totals.data.perDay} />
            </Suspense>
          )}
          <RecentRuns runs={recent} />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <TotalsPanel totals={totals.data} costUsd={costUsd} />
          {costs.data && repoCosts && (
            <Suspense>
              <CostChart days={costs.data.days} totals={repoCosts} />
            </Suspense>
          )}
          {activeRunners && <RunnersPanel runners={activeRunners} />}
          {activeRunners && repos.data && (
            <SetupProblems repos={repos.data} runners={activeRunners} />
          )}
        </div>
      </div>
    </Page>
  );
};
