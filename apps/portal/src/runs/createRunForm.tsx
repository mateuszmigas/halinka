import { Button } from "@halinka/ui/components/button";
import { useForm, useStore } from "@tanstack/react-form";
import { skipToken, useQuery } from "@tanstack/react-query";

import { api } from "../api";
import { FormActions, SelectField } from "../formFields";
import { FormShell } from "../formShell";
import { InputField } from "./inputField";
import { useCreateRun } from "./useCreateRun";

export type CreateRunFormProps = { onCreated: () => void };

export const CreateRunForm = (props: CreateRunFormProps) => {
  const { onCreated } = props;
  const createRun = useCreateRun();
  const form = useForm({
    defaultValues: { repoId: "", workflow: "", inputs: {} as Record<string, string> },
    validators: {
      onSubmitAsync: async ({ value }) => {
        const names: string[] = Object.keys(inputsOf(value.workflow));
        const input = {
          repoId: Number(value.repoId),
          workflow: value.workflow,
          inputs: Object.fromEntries(names.map((name) => [name, value.inputs[name] ?? ""])),
        };
        const errors = await createRun(input, ["repoId", "workflow"]);
        if (errors === undefined) onCreated();
        return errors;
      },
    },
  });
  const repoId = useStore(form.store, (state) => state.values.repoId);
  const workflowPath = useStore(form.store, (state) => state.values.workflow);
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting);
  const repos = useQuery(api.repos.list.queryOptions());
  const workflows = useQuery(
    api.repos.workflows.queryOptions({
      input: repoId === "" ? skipToken : { id: Number(repoId) },
    }),
  );
  const inputsOf = (path: string) =>
    workflows.data?.workflows.find((workflow) => workflow.path === path)?.inputs ?? {};

  return (
    <FormShell form={form}>
      <div className="flex flex-col gap-3">
        <form.Field
          name="repoId"
          listeners={{ onChange: () => form.setFieldValue("workflow", "") }}
        >
          {(field) => (
            <SelectField
              id={field.name}
              label="Repo"
              placeholder="Select a repo"
              value={field.state.value}
              onChange={field.handleChange}
              options={repos.data?.map((repo) => ({ value: String(repo.id), label: repo.name }))}
              disabled={isSubmitting || repos.data === undefined}
              issues={[repos.error ?? undefined, ...field.state.meta.errors]}
            />
          )}
        </form.Field>
        <form.Field
          name="workflow"
          listeners={{ onChange: () => form.setFieldValue("inputs", {}) }}
        >
          {(field) => (
            <SelectField
              id={field.name}
              label="Workflow"
              placeholder="Select a workflow"
              value={field.state.value}
              onChange={field.handleChange}
              options={workflows.data?.workflows.map((workflow) => ({
                value: workflow.path,
                label: workflow.name ?? workflow.path,
              }))}
              disabled={isSubmitting || workflows.data === undefined}
              issues={[workflows.error ?? undefined, ...field.state.meta.errors]}
            />
          )}
        </form.Field>
        {Object.entries(inputsOf(workflowPath)).map(([name, input]) => (
          <form.Field key={`${workflowPath}:${name}`} name={`inputs.${name}`} defaultValue="">
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
        <form.Subscribe
          selector={(state) => state.values.repoId === "" || state.values.workflow === ""}
        >
          {(isIncomplete) => (
            <FormActions>
              <Button type="submit" disabled={isSubmitting || isIncomplete}>
                Start run
              </Button>
            </FormActions>
          )}
        </form.Subscribe>
      </div>
    </FormShell>
  );
};
