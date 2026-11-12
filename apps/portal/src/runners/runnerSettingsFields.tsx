import { type AgentPresetId, agentPresets } from "@halinka/presets";
import { Checkbox } from "@halinka/ui/components/checkbox";
import { Input } from "@halinka/ui/components/input";
import { Label } from "@halinka/ui/components/label";

import type { FormIssue } from "../formErrors";
import { FieldFrame } from "../formFields";
import { FormIssues } from "../formIssues";

const presetIds = Object.keys(agentPresets) as AgentPresetId[];

export type LabelsFieldProps = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  issues: (FormIssue | undefined)[];
  disabled?: boolean;
};

export const LabelsField = (props: LabelsFieldProps) => {
  const { id, value, onChange, issues, disabled } = props;

  return (
    <FieldFrame
      id={id}
      label="Labels"
      description="A run with runs-on goes only to a runner with each of its labels."
      issues={issues}
    >
      {(control) => (
        <Input
          {...control}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="gpu, linux"
          disabled={disabled}
          className="font-mono"
        />
      )}
    </FieldFrame>
  );
};

export type AllowedAgentsFieldProps = {
  id: string;
  value: string[] | null;
  onChange: (value: string[] | null) => void;
  issues: (FormIssue | undefined)[];
  disabled?: boolean;
};

export const AllowedAgentsField = (props: AllowedAgentsFieldProps) => {
  const { id, value, onChange, issues, disabled } = props;

  return (
    <fieldset disabled={disabled} className="flex flex-col gap-1.5">
      <legend className="mb-1.5 font-medium">Allowed agents</legend>
      <Label className="flex items-center gap-2 font-normal">
        <Checkbox
          id={`${id}-every`}
          checked={value === null}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(checked === true ? null : [])}
        />
        Every agent
      </Label>
      {presetIds.map((presetId) => (
        <Label key={presetId} className="flex items-center gap-2 font-normal">
          <Checkbox
            id={`${id}-${presetId}`}
            disabled={disabled || value === null}
            checked={value === null || value.includes(presetId)}
            onCheckedChange={(checked) =>
              onChange(
                checked === true
                  ? [...(value ?? []), presetId]
                  : (value ?? []).filter((agent) => agent !== presetId),
              )
            }
          />
          {agentPresets[presetId].label}
        </Label>
      ))}
      <FormIssues issues={issues} />
    </fieldset>
  );
};
