import { Button } from "@halinka/ui/components/button";
import { useForm } from "@tanstack/react-form";

import { api } from "../api";
import { toFormErrors } from "../formErrors";
import { FormActions } from "../formFields";
import { FormShell } from "../formShell";
import { useInvalidateQueries } from "../useInvalidateQueries";
import { useSubmitMutation } from "../useSubmitMutation";
import { settingsOf, settingsValuesOf } from "./runnerSettings";
import { AllowedAgentsField, LabelsField } from "./runnerSettingsFields";

export type RunnerSettingsFormProps = {
  runner: { id: number; labels: string[]; allowedAgents?: string[] };
  onDone: () => void;
};

export const RunnerSettingsForm = (props: RunnerSettingsFormProps) => {
  const { runner, onDone } = props;
  const update = useSubmitMutation(api.runners.update.mutationOptions());
  const refreshRunners = useInvalidateQueries(api.runners.list.key());
  const form = useForm({
    defaultValues: settingsValuesOf(runner),
    validators: {
      onSubmitAsync: async ({ value }) => {
        const { error } = await update({ id: runner.id, ...settingsOf(value) });
        return error ? toFormErrors(error, ["labels", "allowedAgents"]) : undefined;
      },
    },
    onSubmit: () => {
      void refreshRunners();
      onDone();
    },
  });

  return (
    <FormShell form={form}>
      <form.Field name="labels">
        {(field) => (
          <LabelsField
            id={`runner-${runner.id}-labels`}
            value={field.state.value}
            onChange={field.handleChange}
            issues={field.state.meta.errors}
          />
        )}
      </form.Field>
      <form.Field name="allowedAgents">
        {(field) => (
          <AllowedAgentsField
            id={`runner-${runner.id}-agents`}
            value={field.state.value}
            onChange={field.handleChange}
            issues={field.state.meta.errors}
          />
        )}
      </form.Field>
      <FormActions>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </FormActions>
    </FormShell>
  );
};
