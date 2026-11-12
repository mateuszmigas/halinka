import { type AnyFormApi, useStore } from "@tanstack/react-form";
import type { ReactNode } from "react";

import { FormIssues } from "./formIssues";

export type FormShellProps = {
  form: AnyFormApi;
  children: ReactNode;
  canSubmitOnEnter?: boolean;
  className?: string;
};

export const FormShell = (props: FormShellProps) => {
  const { form, children, canSubmitOnEnter = true, className } = props;
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting);
  const issues = useStore(form.store, (state) => state.errorMap.onSubmit);

  return (
    <form
      className={`flex flex-col gap-1.5 ${className ?? ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmitOnEnter || form.state.isSubmitting) return;
        void form.handleSubmit();
      }}
    >
      {/* The content box of a fieldset does not grow in a flex column. */}
      <fieldset disabled={isSubmitting} className="contents">
        <div className="flex min-w-0 flex-1 flex-col gap-3">{children}</div>
      </fieldset>
      <FormIssues issues={issues} />
    </form>
  );
};
