import { Button } from "@halinka/ui/components/button";
import type { Problem, StepEdit, StepFields } from "@halinka/workflow";

import { WorkflowGates } from "./workflowGates";
import { WorkflowStepFields } from "./workflowStepFields";

export type WorkflowStepsProps = {
  step: StepFields | undefined;
  index: number;
  parent?: number;
  count: number;
  problems: Problem[];
  onChange: (edit: StepEdit) => void;
};

export const WorkflowSteps = (props: WorkflowStepsProps) => {
  const { step, index, parent, count, problems, onChange } = props;
  const path = `${parent === undefined ? "steps" : `steps.${parent}.steps`}.${index}`;

  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-hidden bg-card ring-1 ring-foreground/10"
      aria-label="Step properties"
    >
      <div className="flex items-center justify-between min-h-10 border-b px-4 py-1">
        <h2 className="text-sm font-semibold">Properties</h2>
        {step && (
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {step.type}
          </span>
        )}
      </div>
      {step ? (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
          <div>
            <h3 className="font-medium">{step.id || "Untitled step"}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Changes also update the YAML source.
            </p>
          </div>
          <WorkflowStepFields
            step={step}
            index={index}
            parent={parent}
            path={path}
            problems={problems}
            onChange={onChange}
          />
          {step.type === "agent" && (
            <WorkflowGates
              index={index}
              parent={parent}
              path={path}
              gates={step.gates}
              problems={problems}
              onChange={onChange}
            />
          )}
          <div className="mt-2 flex flex-wrap gap-2 border-t border-border pt-4">
            <Button
              variant="outline"
              disabled={index === 0}
              onClick={() => onChange({ type: "move", index, parent, to: index - 1 })}
            >
              Move earlier
            </Button>
            <Button
              variant="outline"
              disabled={index === count - 1}
              onClick={() => onChange({ type: "move", index, parent, to: index + 1 })}
            >
              Move later
            </Button>
            <Button
              variant="outline"
              className="text-destructive"
              onClick={() => onChange({ type: "delete", index, parent })}
            >
              Delete step
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
          <div className="mb-2 grid size-10 place-items-center rounded-xl bg-muted text-lg text-muted-foreground">
            ↖
          </div>
          <p className="font-medium">Select a step</p>
          <p className="text-sm text-muted-foreground">Choose a node to edit its properties.</p>
        </div>
      )}
    </section>
  );
};
