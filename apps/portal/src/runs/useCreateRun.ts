import { useNavigate } from "@tanstack/react-router";

import { api } from "../api";
import { toFormErrors } from "../formErrors";
import { useInvalidateQueries } from "../useInvalidateQueries";
import { useSubmitMutation } from "../useSubmitMutation";

type CreateRunInput = { repoId: number; workflow: string; inputs: Record<string, string> };

export type RunDraft = { source: string; baseHash: string };

export const useCreateRun = () => {
  const create = useSubmitMutation(api.runs.create.mutationOptions());
  const test = useSubmitMutation(api.runs.test.mutationOptions());
  const refreshWorkflow = useInvalidateQueries(api.repos.workflow.key());
  const navigate = useNavigate();

  return async <Field extends string>(
    input: CreateRunInput,
    fields: readonly Field[],
    draft?: RunDraft,
  ) => {
    const { error, data } = await (draft ? test({ ...input, ...draft }) : create(input));
    const inputFields = Object.keys(input.inputs).map((name) => `inputs.${name}` as const);
    if (error) {
      if (draft) void refreshWorkflow();
      return toFormErrors(error, [...fields, ...inputFields]);
    }
    void navigate({ to: "/runs/$workflowRunId", params: { workflowRunId: data.id } });
    return undefined;
  };
};
