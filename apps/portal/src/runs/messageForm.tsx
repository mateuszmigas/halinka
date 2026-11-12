import { Button } from "@halinka/ui/components/button";
import { Textarea } from "@halinka/ui/components/textarea";
import { useForm } from "@tanstack/react-form";
import { type ReactNode, useId } from "react";

import { api } from "../api";
import { toFormErrors } from "../formErrors";
import { FieldFrame } from "../formFields";
import { FormShell } from "../formShell";
import { useSubmitMutation } from "../useSubmitMutation";

// `children`: more actions before the submit button
export type MessageFormProps = {
  workflowRunId: number;
  stepRunId: number;
  submitLabel: string;
  onSent?: () => void;
  children?: ReactNode;
};

export const MessageForm = (props: MessageFormProps) => {
  const { workflowRunId, stepRunId, submitLabel, onSent, children } = props;
  // The run page can show two of these forms: in the chat and in the reopen dialog.
  const formId = useId();
  const sendMessage = useSubmitMutation(api.runs.sendMessage.mutationOptions());
  const form = useForm({
    defaultValues: { text: "" },
    validators: {
      onSubmitAsync: async ({ value }) => {
        const input = { id: workflowRunId, stepRunId, text: value.text };
        const { error } = await sendMessage(input);
        return error ? toFormErrors(error, ["text"]) : undefined;
      },
    },
    onSubmit: () => {
      form.reset();
      onSent?.();
    },
  });

  return (
    <FormShell form={form}>
      <form.Field name="text">
        {(field) => (
          <FieldFrame
            id={`${formId}${field.name}`}
            label="Message to the agent"
            isLabelHidden
            issues={field.state.meta.errors}
          >
            {(control) => (
              <Textarea
                {...control}
                name={field.name}
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={field.handleBlur}
                placeholder="Message to the agent"
                rows={3}
              />
            )}
          </FieldFrame>
        )}
      </form.Field>
      <div className="flex gap-2">
        {children}
        <Button type="submit">{submitLabel}</Button>
      </div>
    </FormShell>
  );
};
