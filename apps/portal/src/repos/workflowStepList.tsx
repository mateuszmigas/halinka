import { Badge } from "@halinka/ui/components/badge";
import { Button } from "@halinka/ui/components/button";
import { conditionSourceOf, type Problem, type StepFields } from "@halinka/workflow";
import { Fragment, useEffect, useState } from "react";

import { StepChildren } from "../steps/stepChildren";
import { StepKindIcon } from "../steps/stepKindIcon";
import { StepRow } from "../steps/stepRow";
import type { GraphStep, StepAddress, WorkflowGraph } from "./workflowGraph";

type AddedStepType = "shell" | "agent" | "approval" | "github" | "loop";

const options = [
  { type: "agent", label: "Agent", detail: "Give a task to an agent" },
  { type: "shell", label: "Shell", detail: "Execute a command" },
  { type: "approval", label: "Approval", detail: "Wait for a human decision" },
  { type: "github", label: "GitHub", detail: "Open a pull request" },
  { type: "loop", label: "Loop", detail: "Repeat steps until a condition" },
] as const;
const tagClassName = "rounded px-1.5 py-0 text-[11px]";

type Picker = { source: string; address: StepAddress };

const detailOf = (step: StepFields) => {
  if (step.type === "loop")
    return step.until ? `until ${(conditionSourceOf(step.until) ?? step.until).trim()}` : "";
  return (step.prompt || step.run || step.message || step.action || "").split("\n")[0];
};

const problemCountOf = (entry: GraphStep, problems: Problem[]) => {
  const path =
    entry.parent === undefined
      ? ["steps", entry.index]
      : ["steps", entry.parent, "steps", entry.index];
  return problems.filter(
    (problem) =>
      path.every((part, index) => problem.path[index] === part) &&
      (entry.step.type !== "loop" || problem.path[path.length] !== "steps"),
  ).length;
};

const isSameAddress = (a: StepAddress, b: StepAddress) =>
  a.index === b.index && a.parent === b.parent;

type InsertGapProps = { label: string; disabled: boolean; onClick: () => void };

const InsertGap = (props: InsertGapProps) => {
  const { label, disabled, onClick } = props;

  return (
    <div className="group relative h-1.5">
      <span className="absolute inset-x-2 top-1/2 border-t border-primary opacity-0 group-focus-within:opacity-60 group-hover:opacity-60" />
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="absolute top-1/2 left-1/2 z-10 grid size-[18px] -translate-1/2 scale-75 place-items-center rounded-full border border-primary bg-background text-xs leading-none text-primary opacity-0 transition group-hover:scale-100 group-hover:opacity-100 focus-visible:scale-100 focus-visible:opacity-100 disabled:hidden"
      >
        +
      </button>
    </div>
  );
};

export type WorkflowStepListProps = {
  graph: WorkflowGraph;
  selected: string | undefined;
  problems: Problem[];
  readOnly: boolean;
  onSelect: (key: string) => void;
  onInsert: (type: AddedStepType, at: number, parent?: number) => void;
};

export const WorkflowStepList = (props: WorkflowStepListProps) => {
  const { graph, selected, problems, readOnly, onSelect, onInsert } = props;
  const [picker, setPicker] = useState<Picker>();
  useEffect(() => {
    if (!picker) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPicker(undefined);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [picker]);
  const openPicker = picker?.source === graph.source && !readOnly ? picker : undefined;
  const root = graph.entries.filter((entry) => entry.parent === undefined);

  const togglePicker = (address: StepAddress) =>
    setPicker(
      openPicker && isSameAddress(openPicker.address, address)
        ? undefined
        : { source: graph.source, address },
    );
  const insert = (type: AddedStepType) => {
    if (!openPicker) return;
    onInsert(type, openPicker.address.index, openPicker.address.parent);
    setPicker(undefined);
  };
  const pickerAt = (address: StepAddress) =>
    openPicker &&
    isSameAddress(openPicker.address, address) && (
      <div
        role="dialog"
        aria-label="Add workflow step"
        className="mx-1 my-1 flex flex-col rounded-lg border border-border bg-background p-1 shadow-md"
      >
        {options
          .filter(({ type }) => type !== "loop" || address.parent === undefined)
          .map((option) => (
            <Button
              key={option.type}
              variant="outline"
              className="h-auto w-full justify-start gap-3 border-transparent px-2 py-1.5 text-left"
              onClick={() => insert(option.type)}
            >
              <StepKindIcon kind={option.type} className="size-7 rounded-md text-sm" />
              <span>
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="block text-xs font-normal text-muted-foreground">
                  {option.detail}
                </span>
              </span>
            </Button>
          ))}
      </div>
    );
  const gap = (address: StepAddress, before: string) => (
    <>
      <InsertGap
        label={`Add a step before ${before || "untitled"}`}
        disabled={readOnly}
        onClick={() => togglePicker(address)}
      />
      {pickerAt(address)}
    </>
  );
  const addButton = (address: StepAddress, label: string) => (
    <>
      <button
        type="button"
        disabled={readOnly}
        onClick={() => togglePicker(address)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-muted hover:text-primary disabled:opacity-50"
      >
        <span className="w-5 text-center">+</span>
        {label}
      </button>
      {pickerAt(address)}
    </>
  );
  const row = (entry: GraphStep) => {
    const count = problemCountOf(entry, problems);
    return (
      <StepRow
        icon={
          <>
            <StepKindIcon kind={entry.step.type} />
            <span className="sr-only">{entry.step.type}</span>
          </>
        }
        stepId={entry.id || "untitled"}
        detail={detailOf(entry.step)}
        tags={
          (entry.step.if || count > 0) && (
            <>
              {entry.step.if && (
                <Badge className={`${tagClassName} font-mono`} title={entry.step.if}>
                  if
                </Badge>
              )}
              {count > 0 && (
                <Badge variant="destructive" className={tagClassName}>
                  {count} error{count === 1 ? "" : "s"}
                </Badge>
              )}
            </>
          )
        }
        isSelected={entry.key === selected}
        onSelect={() => {
          setPicker(undefined);
          onSelect(entry.key);
        }}
      />
    );
  };

  return (
    <section
      className="flex h-full min-h-80 flex-col overflow-hidden bg-card ring-1 ring-foreground/10"
      aria-label="Workflow steps"
    >
      <div className="flex items-center justify-between min-h-10 border-b px-4 py-1">
        <h2 className="text-sm font-semibold">Steps</h2>
        <span className="text-xs text-muted-foreground">{graph.entries.length} steps</span>
      </div>
      {graph.isReadable ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto p-2">
          {root.map((entry) => {
            const children = graph.entries.filter((child) => child.parent === entry.index);
            return (
              <Fragment key={entry.key}>
                {gap({ index: entry.index }, entry.id)}
                {row(entry)}
                {entry.step.type === "loop" && (
                  <StepChildren>
                    {children.map((child) => (
                      <Fragment key={child.key}>
                        {gap({ index: child.index, parent: entry.index }, child.id)}
                        {row(child)}
                      </Fragment>
                    ))}
                    {addButton({ index: children.length, parent: entry.index }, "Add child")}
                  </StepChildren>
                )}
              </Fragment>
            );
          })}
          {root.length === 0 && (
            <p className="px-2 py-3 text-muted-foreground">Add the first step to begin.</p>
          )}
          {addButton({ index: root.length }, "Add step")}
        </div>
      ) : (
        <div className="grid flex-1 place-content-center gap-2 p-6 text-center">
          <p className="font-medium">The steps cannot be shown yet.</p>
          <p className="text-muted-foreground">Correct the YAML to continue editing steps.</p>
        </div>
      )}
    </section>
  );
};
