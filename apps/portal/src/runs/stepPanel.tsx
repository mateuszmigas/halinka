import type { ApiOutputs } from "@halinka/server/client";
import { Checkbox } from "@halinka/ui/components/checkbox";
import { Label } from "@halinka/ui/components/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@halinka/ui/components/tabs";
import { Fragment, useId, useState } from "react";

import { ErrorText } from "../errorText";
import { formatCost } from "../formatCost";
import { formatDateTime } from "../formatDateTime";
import { decisionLabels } from "../inbox/decisionLabels";
import { RunInboxItem } from "../inbox/runInboxItems";
import { Panel } from "../panel";
import { PanelBody } from "../panelBody";
import { ChatMessage } from "./chatMessage";
import { MessageForm } from "./messageForm";
import { ReopenStepButton } from "./reopenStepButton";
import { RetryStepButton } from "./retryStepButton";
import { StatusLabel } from "./statusLabel";
import { attemptItemsOf, type TranscriptItem } from "./transcript";
import { TranscriptEvent } from "./transcriptEvent";
import type { WaitingMessage } from "./waitingMessages";

const rewindText = "Closed: the run went back to an earlier step";

type RunDetail = ApiOutputs["runs"]["get"];
type StepRun = RunDetail["stepRuns"][number];

const formatOutput = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);

type TranscriptProps = {
  run: RunDetail;
  stepRun: StepRun;
  items: TranscriptItem[];
  error: Error | undefined;
  waiting: WaitingMessage[];
};

const Transcript = (props: TranscriptProps) => {
  const { run, stepRun, items, error, waiting } = props;
  const { messageTarget } = run;
  const toggleId = useId();
  const [isSystemShown, setIsSystemShown] = useState(false);
  const [pinnedAttemptId, setPinnedAttemptId] = useState<number>();
  const attempts = run.attempts.filter((attempt) => attempt.stepRunId === stepRun.id);
  const latestId = attempts.at(-1)?.id;
  const shownId = pinnedAttemptId ?? latestId;
  const { all, visible } = attemptItemsOf(items, shownId);
  const systemCount = all.length - visible.length;

  const events = (
    <>
      {systemCount > 0 && (
        <div className="flex items-center justify-end gap-2 text-muted-foreground">
          <Checkbox
            id={toggleId}
            checked={isSystemShown}
            onCheckedChange={(checked) => setIsSystemShown(checked === true)}
          />
          <Label htmlFor={toggleId}>Show {systemCount} system events</Label>
        </div>
      )}
      <ErrorText error={error} />
      {all.length === 0 && !error && <p className="text-muted-foreground">No events.</p>}
      {(isSystemShown ? all : visible).map((item) => (
        <TranscriptEvent key={item.seq} event={item.event} />
      ))}
    </>
  );

  return (
    <section aria-label="Transcript" className="flex flex-col gap-3">
      {attempts.length > 1 ? (
        <Tabs
          value={String(shownId)}
          onValueChange={(value) =>
            setPinnedAttemptId(Number(value) === latestId ? undefined : Number(value))
          }
        >
          <TabsList aria-label="Attempts">
            {attempts.map((attempt) => (
              <TabsTrigger key={attempt.id} value={String(attempt.id)}>
                Attempt {attempt.attempt}
                <StatusLabel status={attempt.status} />
                {attempt.exitCode ? (
                  <span className="font-mono text-xs text-destructive">
                    exit {attempt.exitCode}
                  </span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={String(shownId)} className="flex flex-col gap-3">
            {events}
          </TabsContent>
        </Tabs>
      ) : (
        events
      )}
      {waiting
        .filter((message) => message.stepRunId === stepRun.id)
        .map(({ id, author, text, isWaiting }) => (
          <ChatMessage
            key={id}
            author={author}
            text={text}
            status={isWaiting ? "Waiting for the agent" : "Not delivered"}
          />
        ))}
      {messageTarget?.stepRunId === stepRun.id && (
        <MessageForm
          workflowRunId={run.id}
          stepRunId={stepRun.id}
          submitLabel={
            messageTarget.decision
              ? `Send and ${decisionLabels[messageTarget.decision].action.toLowerCase()}`
              : "Send"
          }
        />
      )}
    </section>
  );
};

export type StepPanelProps = {
  run: RunDetail;
  stepRun: StepRun | undefined;
  items: TranscriptItem[];
  error: Error | undefined;
  waiting: WaitingMessage[];
  onRewound: () => void;
};

export const StepPanel = (props: StepPanelProps) => {
  const { run, stepRun, items, error, waiting, onRewound } = props;

  if (!stepRun) {
    return (
      <Panel title="Selected step" hasHeader={false}>
        <PanelBody>
          <ErrorText error={error} />
          <p className="text-muted-foreground">The run has not started a step.</p>
        </PanelBody>
      </Panel>
    );
  }

  return (
    <Panel title="Selected step" hasHeader={false}>
      <PanelBody>
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="flex flex-wrap items-center gap-2 font-mono text-base font-semibold">
              {stepRun.stepId}
              <StatusLabel status={stepRun.status} />
              {stepRun.outcome && (
                <span className="font-sans font-normal text-muted-foreground">
                  {stepRun.outcome}
                </span>
              )}
            </h2>
            <p className="flex flex-wrap gap-x-4 text-muted-foreground">
              {stepRun.iteration !== undefined && <span>Iteration {stepRun.iteration}</span>}
              <span>{formatDateTime(stepRun.startedAt)}</span>
              {stepRun.finishedAt && <span>to {formatDateTime(stepRun.finishedAt)}</span>}
              {stepRun.usage && <span>{formatCost(stepRun.usage.costUsd)}</span>}
            </p>
          </div>
          <div className="flex gap-2">
            {run.reopenTargets.includes(stepRun.id) && (
              <ReopenStepButton
                workflowRunId={run.id}
                stepRunId={stepRun.id}
                stepId={stepRun.stepId}
                onReopened={onRewound}
              />
            )}
            {run.retryTargets.includes(stepRun.id) && (
              <RetryStepButton
                workflowRunId={run.id}
                stepRunId={stepRun.id}
                onRetried={onRewound}
              />
            )}
          </div>
        </header>
        {stepRun.summary && <p className="whitespace-pre-wrap">{stepRun.summary}</p>}
        {stepRun.outputs && (
          <details>
            <summary className="cursor-pointer text-muted-foreground">Outputs</summary>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {Object.entries(stepRun.outputs).map(([name, value]) => (
                <Fragment key={name}>
                  <dt className="text-muted-foreground">{name}</dt>
                  <dd className="font-mono break-all">{formatOutput(value)}</dd>
                </Fragment>
              ))}
            </dl>
          </details>
        )}
        {run.inboxItems
          .filter(({ stepRunId, resolvedAt }) => stepRunId === stepRun.id && resolvedAt)
          .map((item) => (
            <RunInboxItem
              key={item.id}
              item={item}
              closedText={stepRun.status === "superseded" ? rewindText : undefined}
            />
          ))}
        <Transcript
          key={stepRun.id}
          run={run}
          stepRun={stepRun}
          items={items}
          error={error}
          waiting={waiting}
        />
      </PanelBody>
    </Panel>
  );
};
