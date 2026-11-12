import {
  formFieldsOf,
  type Problem,
  type StepEdit,
  type StepField,
  type StepFields,
} from "@halinka/workflow";

import { WorkflowStepField } from "./workflowStepField";

const labels: Record<StepField, string> = {
  id: "Step ID",
  until: "Repeat until",
  max_iterations: "Maximum iterations",
  run: "Command",
  if: "Condition",
  timeout: "Timeout",
  agent: "Agent",
  model: "Model",
  prompt: "Prompt",
  message: "Message",
  action: "Action",
  title: "Pull request title",
  body: "Body",
  closes: "Issue to close",
  max_attempts: "Maximum attempts",
  on_exhausted: "When attempts are exhausted",
  max_turns: "Maximum prompt turns",
  max_cost_usd: "Maximum cost in USD",
  max_reminders: "Maximum reminders",
};

const multilineFields: readonly StepField[] = ["run", "prompt", "message", "body"];

export type WorkflowStepFieldsProps = {
  step: StepFields;
  index: number;
  parent?: number;
  path: string;
  problems: Problem[];
  onChange: (edit: StepEdit) => void;
};

export const WorkflowStepFields = (props: WorkflowStepFieldsProps) => {
  const { step, index, parent, path, problems, onChange } = props;
  const fields = formFieldsOf(step.type);
  if (!fields)
    return <p className="text-muted-foreground">Use the YAML editor to edit this step.</p>;

  return fields.map(({ name, isOptional, isNumeric, options }) => (
    <WorkflowStepField
      key={name}
      name={`${path}.${name}`}
      label={labels[name]}
      value={step[name]}
      problems={problems}
      onChange={(value) => onChange({ type: "set", index, parent, field: name, value })}
      isOptional={isOptional}
      isMultiline={multilineFields.includes(name)}
      isNumeric={isNumeric}
      options={options}
    />
  ));
};
