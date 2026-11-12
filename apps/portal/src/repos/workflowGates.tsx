import { Button } from "@halinka/ui/components/button";
import { gateFailActions, type GateFields, type Problem, type StepEdit } from "@halinka/workflow";

import { WorkflowStepField } from "./workflowStepField";

const gateFields: {
  field: keyof GateFields;
  label: string;
  isOptional?: boolean;
  isMultiline?: boolean;
  options?: readonly string[];
}[] = [
  { field: "name", label: "Gate name" },
  { field: "run", label: "Gate command", isMultiline: true },
  {
    field: "on_fail",
    label: "When the gate fails",
    isOptional: true,
    options: gateFailActions,
  },
];

export type WorkflowGatesProps = {
  index: number;
  parent?: number;
  path: string;
  gates: GateFields[] | undefined;
  problems: Problem[];
  onChange: (edit: StepEdit) => void;
};

export const WorkflowGates = (props: WorkflowGatesProps) => {
  const { index, parent, path, gates, problems, onChange } = props;

  return (
    <section className="flex flex-col gap-3" aria-label={`Gates for step ${index + 1}`}>
      <h4 className="font-semibold">Gates</h4>
      {gates === undefined ? (
        <p>Use the YAML editor to correct the gate list.</p>
      ) : (
        <>
          {gates.map((gate, gateIndex) => (
            <div
              key={gateIndex}
              className="flex flex-col gap-3 rounded-lg border border-border p-3"
            >
              {gateFields.map(({ field, label, isOptional, isMultiline, options }) => (
                <WorkflowStepField
                  key={field}
                  name={`${path}.gates.${gateIndex}.${field}`}
                  label={label}
                  value={gate[field]}
                  problems={problems}
                  onChange={(value) =>
                    onChange({ type: "set_gate", index, parent, gate: gateIndex, field, value })
                  }
                  isOptional={isOptional}
                  isMultiline={isMultiline}
                  options={options}
                />
              ))}
              <Button
                variant="outline"
                className="self-start"
                onClick={() => onChange({ type: "delete_gate", index, parent, gate: gateIndex })}
                aria-label={`Remove gate ${gateIndex + 1} from step ${index + 1}`}
              >
                Remove gate
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            className="self-start"
            onClick={() => onChange({ type: "add_gate", index, parent })}
          >
            Add gate
          </Button>
        </>
      )}
    </section>
  );
};
