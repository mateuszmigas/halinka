import { Input } from "@halinka/ui/components/input";
import { Textarea } from "@halinka/ui/components/textarea";
import type { Problem } from "@halinka/workflow";

import { problemIssues } from "../formErrors";
import { FieldFrame, noValue, SelectField } from "../formFields";

export type WorkflowStepFieldProps = {
  name: string;
  label: string;
  value: string;
  problems: Problem[];
  onChange: (value: string) => void;
  isOptional?: boolean;
  isMultiline?: boolean;
  isNumeric?: boolean;
  options?: readonly string[];
};

export const WorkflowStepField = (props: WorkflowStepFieldProps) => {
  const { name, label, value, problems, onChange, isOptional, isMultiline, isNumeric, options } =
    props;
  const frame = {
    id: name,
    label: isOptional ? `${label} (optional)` : label,
    issues: problemIssues(problems.filter((problem) => problem.path.join(".") === name)),
  };

  if (options) {
    const choices = value && !options.includes(value) ? [value, ...options] : options;
    return (
      <SelectField
        {...frame}
        value={value || noValue}
        onChange={(selected) => onChange(selected === noValue ? "" : selected)}
        options={[
          ...(isOptional ? [{ value: noValue, label: "Default" }] : []),
          ...choices.map((option) => ({ value: option, label: option })),
        ]}
      />
    );
  }

  return (
    <FieldFrame {...frame}>
      {(control) => {
        const input = {
          ...control,
          name,
          value,
          onChange: (event: { target: { value: string } }) => onChange(event.target.value),
          className: "font-mono",
        };
        return isMultiline ? (
          <Textarea {...input} rows={3} />
        ) : (
          <Input {...input} inputMode={isNumeric ? "decimal" : undefined} />
        );
      }}
    </FieldFrame>
  );
};
