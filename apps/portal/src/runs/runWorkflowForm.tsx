import { Button } from "@halinka/ui/components/button";
import { useForm, useStore } from "@tanstack/react-form";

import { FieldAction } from "../formFields";
import { FormShell } from "../formShell";
import { InputField, type WorkflowInput } from "./inputField";
import { type RunDraft, useCreateRun } from "./useCreateRun";

export type RunWorkflowFormProps = {
  repoId: number;
  path: string;
  inputs: Record<string, WorkflowInput>;
  draft?: RunDraft;
};

export const RunWorkflowForm = (props: RunWorkflowFormProps) => {
  const { repoId, path, inputs, draft } = props;
  const createRun = useCreateRun();
  const names = Object.keys(inputs);
  const form = useForm({
    defaultValues: { inputs: Object.fromEntries(names.map((name) => [name, ""])) },
    validators: {
      onSubmitAsync: ({ value }) =>
        createRun({ repoId, workflow: path, inputs: value.inputs }, [], draft),
    },
  });
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting);

  const submit = (
    <Button type="submit" disabled={isSubmitting}>
      {draft ? "Start test run" : "Start run"}
    </Button>
  );

  return (
    <FormShell form={form}>
      <div className="flex flex-wrap items-start gap-4">
        {Object.entries(inputs).map(([name, input]) => (
          <form.Field key={name} name={`inputs.${name}`}>
            {(field) => (
              <InputField
                id={field.name}
                name={name}
                input={input}
                value={field.state.value}
                onChange={field.handleChange}
                disabled={isSubmitting}
                issues={field.state.meta.errors}
              />
            )}
          </form.Field>
        ))}
        {names.length > 0 ? <FieldAction>{submit}</FieldAction> : submit}
      </div>
    </FormShell>
  );
};
