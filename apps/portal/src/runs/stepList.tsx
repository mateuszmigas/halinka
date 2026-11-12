import type { ApiOutputs } from "@halinka/server/client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@halinka/ui/components/tabs";
import { Fragment, useState } from "react";

import { StepChildren } from "../steps/stepChildren";
import { StepRow } from "../steps/stepRow";
import { groupStepRuns } from "./groupStepRuns";
import { notStartedStepsOf } from "./notStartedSteps";
import { shownIterationOf } from "./shownIteration";
import { StepStatusIcon } from "./stepStatusIcon";

type RunDetail = ApiOutputs["runs"]["get"];
type StepRun = RunDetail["stepRuns"][number];

const NotStartedRow = (props: { stepId: string }) => (
  <StepRow
    icon={<StepStatusIcon status="not_started" />}
    stepId={props.stepId}
    detail="not started"
    tone="muted"
  />
);

export type StepListProps = {
  run: RunDetail;
  selectedId: number | undefined;
  waitingStepRunIds: ReadonlySet<number>;
  onSelect: (stepRunId: number) => void;
};

export const StepList = (props: StepListProps) => {
  const { run, selectedId, waitingStepRunIds, onSelect } = props;
  const [chosen, setChosen] = useState<Record<number, number>>({});

  const row = (stepRun: StepRun) => {
    const isWaiting = waitingStepRunIds.has(stepRun.id);
    return (
      <StepRow
        key={stepRun.id}
        icon={<StepStatusIcon status={stepRun.status} isWaiting={isWaiting} />}
        stepId={stepRun.stepId}
        detail={stepRun.outcome && <span className="font-mono">{stepRun.outcome}</span>}
        tone={isWaiting ? "attention" : stepRun.status === "superseded" ? "muted" : "default"}
        isSelected={stepRun.id === selectedId}
        onSelect={() => {
          setChosen({});
          onSelect(stepRun.id);
        }}
      />
    );
  };

  return (
    <nav aria-label="Steps" className="flex flex-col gap-0.5">
      {groupStepRuns(run.stepRuns).map(({ stepRun, iterations }) => {
        const shown = shownIterationOf(iterations, selectedId, chosen[stepRun.id]);
        const shownIteration = iterations.find(({ iteration }) => iteration === shown);
        if (!shownIteration) return row(stepRun);
        const loop = run.workflow.steps.find(({ id }) => id === stepRun.stepId);
        const notStartedChildren =
          loop?.type === "loop" && stepRun.status !== "superseded"
            ? notStartedStepsOf(loop.steps, shownIteration.stepRuns)
            : [];

        return (
          <Fragment key={stepRun.id}>
            {row(stepRun)}
            <StepChildren>
              <Tabs
                value={String(shown)}
                onValueChange={(value) =>
                  setChosen((all) => ({ ...all, [stepRun.id]: Number(value) }))
                }
                className="gap-0.5"
              >
                <div className="flex items-center gap-2 px-2 pt-1 text-xs text-muted-foreground">
                  Iteration
                  <TabsList aria-label={`Iterations of ${stepRun.stepId}`} className="border-b-0">
                    {iterations.map(({ iteration }) => (
                      <TabsTrigger
                        key={iteration}
                        value={String(iteration)}
                        className="px-1.5 py-0.5 tabular-nums"
                      >
                        {iteration}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>
                <TabsContent value={String(shown)} className="flex flex-col gap-0.5">
                  {shownIteration.stepRuns.map(row)}
                  {notStartedChildren.map((child) => (
                    <NotStartedRow key={child.id} stepId={child.id} />
                  ))}
                </TabsContent>
              </Tabs>
            </StepChildren>
          </Fragment>
        );
      })}
      {notStartedStepsOf(run.workflow.steps, run.stepRuns).map((step) => (
        <NotStartedRow key={step.id} stepId={step.id} />
      ))}
    </nav>
  );
};
