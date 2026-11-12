import { Badge } from "@halinka/ui/components/badge";
import { Button } from "@halinka/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { api } from "../api";
import { RunInboxItem } from "../inbox/runInboxItems";
import { Page, PageHeader } from "../page";
import { Panel } from "../panel";
import { PanelBody } from "../panelBody";
import { QueryFallback } from "../queryFallback";
import { currentStepRunIdOf } from "./currentStepRunId";
import { RunActionButton } from "./runActionButton";
import { RunFacts } from "./runFacts";
import { StatusLabel } from "./statusLabel";
import { StepList } from "./stepList";
import { StepPanel } from "./stepPanel";
import { useSwitchPane } from "./useSwitchPane";
import { useWatchRun } from "./useWatchRun";
import { waitingMessages } from "./waitingMessages";

const errorClassName =
  "rounded-lg border border-destructive/50 bg-card p-4 whitespace-pre-wrap text-destructive";

export const RunPage = () => {
  const { workflowRunId } = useParams({ from: "/runs/$workflowRunId" });
  const query = useQuery(api.runs.get.queryOptions({ input: { id: workflowRunId } }));
  const watch = useWatchRun(workflowRunId);
  const { isStepOpen, openStep, openStepList, stepListRef, stepListButtonRef } = useSwitchPane();
  const [pin, setPin] = useState<{ stepRunId: number; isSuperseded: boolean }>();
  const run = query.data;
  const waiting = useMemo(
    () => (run === undefined ? [] : waitingMessages(run, watch.items)),
    [run, watch.items],
  );

  if (run === undefined) {
    return (
      <Page>
        <QueryFallback error={query.error} />
      </Page>
    );
  }

  const currentId = currentStepRunIdOf(run);
  const pinned = run.stepRuns.find(({ id }) => id === pin?.stepRunId);
  // A pin ends when a reopen elsewhere supersedes its step run.
  const shownId =
    pinned && (pinned.status === "superseded") === pin?.isSuperseded ? pinned.id : currentId;
  // The agent takes a waiting message instead of an answer.
  const pending = run.inboxItems.filter(
    ({ kind, stepRunId, resolvedAt }) =>
      resolvedAt === undefined &&
      !(kind === "question" && waiting.some((message) => message.stepRunId === stepRunId)),
  );
  const waitingStepRunIds = new Set(pending.map(({ stepRunId }) => stepRunId));
  const sandboxError = run.sandbox?.error;

  return (
    <Page>
      <PageHeader
        crumbLabel={`Run #${run.id}`}
        title={
          <>
            #{run.id} {run.workflowName}
            <StatusLabel status={run.status} />
            {run.isTestRun && <Badge>Test run</Badge>}
          </>
        }
        description={
          <>
            {run.workflowPath}
            {run.isSetupSkipped && (
              <span className="mt-1 block">
                This run skipped setup.run: the setup needs secrets, and a test run or a run on a
                pull request gets none.
              </span>
            )}
          </>
        }
        actions={
          <>
            {run.canCancel && <RunActionButton action="cancel" workflowRunId={run.id} />}
            {run.canPush && <RunActionButton action="push" workflowRunId={run.id} />}
            {run.canOpenPullRequest && (
              <RunActionButton action="openPullRequest" workflowRunId={run.id} />
            )}
            {run.canDelete && <RunActionButton action="delete" workflowRunId={run.id} />}
          </>
        }
      />
      {(run.error || sandboxError || pending.length > 0) && (
        <section aria-label="Needs attention" className="flex flex-col gap-3">
          {run.error && <p className={errorClassName}>{run.error}</p>}
          {sandboxError && <p className={errorClassName}>Workspace: {sandboxError}</p>}
          {pending.map((item) => (
            <RunInboxItem key={item.id} item={item} />
          ))}
        </section>
      )}
      <div className="grid items-start gap-6 md:grid-cols-[16rem_minmax(0,1fr)]">
        <div
          ref={stepListRef}
          className={`flex min-w-0 flex-col gap-6 ${isStepOpen ? "max-md:hidden" : ""}`}
        >
          <Panel title="Steps" count={run.stepRuns.length}>
            <PanelBody>
              <StepList
                run={run}
                selectedId={shownId}
                waitingStepRunIds={waitingStepRunIds}
                onSelect={(id) => {
                  setPin(
                    id === currentId
                      ? undefined
                      : {
                          stepRunId: id,
                          isSuperseded: run.stepRuns.some(
                            (stepRun) => stepRun.id === id && stepRun.status === "superseded",
                          ),
                        },
                  );
                  openStep();
                }}
              />
            </PanelBody>
          </Panel>
          <Panel title="Details">
            <PanelBody>
              <RunFacts run={run} />
            </PanelBody>
          </Panel>
        </div>
        <div className={`flex min-w-0 flex-col gap-3 ${isStepOpen ? "" : "max-md:hidden"}`}>
          <Button
            ref={stepListButtonRef}
            variant="ghost"
            className="self-start md:hidden"
            onClick={openStepList}
          >
            <ChevronLeftIcon data-icon="inline-start" />
            Steps
          </Button>
          <StepPanel
            run={run}
            stepRun={run.stepRuns.find(({ id }) => id === shownId)}
            items={watch.items}
            error={watch.error}
            waiting={waiting}
            onRewound={() => setPin(undefined)}
          />
        </div>
      </div>
    </Page>
  );
};
