import { Label } from "@halinka/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@halinka/ui/components/select";
import type { ReactNode } from "react";

import type { FormIssue } from "./formErrors";
import { FormIssues } from "./formIssues";

// The Select shows the value "" as no selection.
export const noValue = "-";

type FieldControlProps = { id: string; "aria-invalid": boolean };

type FieldFrameProps = {
  id: string;
  label: string;
  description?: string;
  isLabelHidden?: boolean;
  issues: (FormIssue | undefined)[];
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
};

const hasIssues = (issues: (FormIssue | undefined)[]) =>
  issues.some((issue) => issue !== undefined);

export const FieldFrame = (props: FieldFrameProps) => {
  const { id, label, description, isLabelHidden, issues, className, children } = props;

  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      <Label htmlFor={id} className={isLabelHidden ? "sr-only" : undefined}>
        {label}
      </Label>
      {children({ id, "aria-invalid": hasIssues(issues) })}
      {description && <p className="text-muted-foreground">{description}</p>}
      <FormIssues issues={issues} />
    </div>
  );
};

export type FieldActionProps = { children: ReactNode };

// Keeps an action on the row of the controls beside it, under the line of their labels.
export const FieldAction = (props: FieldActionProps) => {
  const { children } = props;

  return (
    <div className="flex flex-col gap-1.5">
      <Label aria-hidden className="invisible">
        &nbsp;
      </Label>
      <div className="flex gap-2">{children}</div>
    </div>
  );
};

export type FormActionsProps = { children: ReactNode };

export const FormActions = (props: FormActionsProps) => {
  const { children } = props;

  return <div className="flex justify-end gap-2">{children}</div>;
};

type SelectFieldProps = Omit<FieldFrameProps, "children" | "className"> & {
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[] | undefined;
  disabled?: boolean;
};

export const SelectField = (props: SelectFieldProps) => {
  const { placeholder, value, onChange, options, disabled, ...frame } = props;

  return (
    <FieldFrame {...frame}>
      {(control) => (
        <Select
          items={options}
          value={value}
          onValueChange={(selected) => onChange(selected ?? "")}
          disabled={disabled}
        >
          <SelectTrigger {...control} className="w-full min-w-48">
            <SelectValue placeholder={placeholder} />
          </SelectTrigger>
          <SelectContent>
            {options?.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </FieldFrame>
  );
};
