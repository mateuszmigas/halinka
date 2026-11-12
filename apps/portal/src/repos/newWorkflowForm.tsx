import { Button } from "@halinka/ui/components/button";
import { Input } from "@halinka/ui/components/input";
import { newWorkflowSource } from "@halinka/workflow";
import { useForm } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";

import { FieldFrame } from "../formFields";
import { FormShell } from "../formShell";
import { fileName } from "./fileName";
import { useWriteWorkflow } from "./useWriteWorkflow";

export type NewWorkflowFormProps = { repoId: number };

export const NewWorkflowForm = (props: NewWorkflowFormProps) => {
  const { repoId } = props;
  const writeWorkflow = useWriteWorkflow(repoId);
  const navigate = useNavigate();
  const form = useForm({
    defaultValues: { workflow: "" },
    validators: {
      onSubmitAsync: async ({ value }) => {
        const { workflow } = value;
        const input = { workflow, source: newWorkflowSource(workflow) };
        const { errors, written } = await writeWorkflow(input, ["workflow"]);
        if (errors) return errors;
        void navigate({
          to: "/repos/$repoId/workflows/$file",
          params: { repoId, file: fileName(written.path) },
        });
        return undefined;
      },
    },
  });

  return (
    <FormShell form={form}>
      <form.Field name="workflow">
        {(field) => (
          <FieldFrame id={field.name} label="Workflow file name" issues={field.state.meta.errors}>
            {(control) => (
              <div className="flex gap-2">
                <Input
                  {...control}
                  name={field.name}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={field.handleBlur}
                  placeholder="build.yml"
                  className="font-mono"
                />
                <Button type="submit">Create</Button>
              </div>
            )}
          </FieldFrame>
        )}
      </form.Field>
    </FormShell>
  );
};
