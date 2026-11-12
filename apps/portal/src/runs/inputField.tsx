import type { ApiOutputs } from "@halinka/server/client";
import { Input } from "@halinka/ui/components/input";

import type { FormIssue } from "../formErrors";
import { FieldFrame, noValue, SelectField } from "../formFields";

export type WorkflowInput = NonNullable<
  ApiOutputs["repos"]["workflows"]["workflows"][number]["inputs"]
>[string];

type InputFieldProps = {
  id: string;
  name: string;
  input: WorkflowInput;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  issues: (FormIssue | undefined)[];
};

export const InputField = (props: InputFieldProps) => {
  const { id, name, input, value, onChange, disabled, issues } = props;
  const label = input.required ? `${name} (required)` : name;
  // The server uses the default for a blank value.
  const placeholder = input.default === undefined ? "Not set" : String(input.default);
  const frame = { id, label, description: input.description, issues };

  if (input.type === "boolean") {
    return (
      <SelectField
        {...frame}
        placeholder={placeholder}
        value={value}
        onChange={(selected) => onChange(selected === noValue ? "" : selected)}
        options={[
          { value: "true", label: "true" },
          { value: "false", label: "false" },
          { value: noValue, label: placeholder },
        ]}
        disabled={disabled}
      />
    );
  }

  return (
    <FieldFrame {...frame}>
      {(control) => (
        <Input
          {...control}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          inputMode={input.type === "number" ? "decimal" : undefined}
          className="min-w-48"
          disabled={disabled}
        />
      )}
    </FieldFrame>
  );
};
