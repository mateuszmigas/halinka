import {
  type DecisionItemDecision,
  type DecisionItemKind,
  kindDecisions,
} from "@halinka/server/client";
import { Button } from "@halinka/ui/components/button";
import { Input } from "@halinka/ui/components/input";
import { useForm } from "@tanstack/react-form";

import { FieldFrame } from "../formFields";
import { FormShell } from "../formShell";
import { decisionLabels } from "./decisionLabels";
import { useResolveInboxItem } from "./useResolveInboxItem";

export type DecisionFormProps = { itemId: number; kind: DecisionItemKind };

export const DecisionForm = (props: DecisionFormProps) => {
  const { itemId, kind } = props;
  const decisions: readonly DecisionItemDecision[] = kindDecisions[kind];
  const { resolve, refresh } = useResolveInboxItem();
  const form = useForm({
    defaultValues: { note: "", decision: decisions[0] as DecisionItemDecision },
    validators: {
      onSubmitAsync: ({ value }) => resolve({ id: itemId, ...value }),
    },
    onSubmit: refresh,
  });
  const decide = (decision: DecisionItemDecision) => {
    if (form.state.isSubmitting) return;
    form.setFieldValue("decision", decision);
    void form.handleSubmit();
  };

  return (
    <FormShell form={form} canSubmitOnEnter={false}>
      <div className="flex flex-wrap gap-2">
        <form.Field name="note">
          {(field) => (
            <FieldFrame
              id={`decision-${itemId}-${field.name}`}
              label="Note"
              isLabelHidden
              issues={field.state.meta.errors}
              className="max-w-sm min-w-48 flex-1"
            >
              {(control) => (
                <Input
                  {...control}
                  name={field.name}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={field.handleBlur}
                  placeholder="Note (optional)"
                />
              )}
            </FieldFrame>
          )}
        </form.Field>
        {decisions.map((decision, index) => (
          <Button
            key={decision}
            variant={index === 0 ? "default" : "outline"}
            onClick={() => decide(decision)}
          >
            {decisionLabels[decision].action}
          </Button>
        ))}
      </div>
    </FormShell>
  );
};
