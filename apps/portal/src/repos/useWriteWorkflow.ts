import { api } from "../api";
import { type FormErrors, toFormErrors } from "../formErrors";
import { useInvalidateQueries } from "../useInvalidateQueries";
import { useSubmitMutation } from "../useSubmitMutation";

type WriteWorkflowInput = { workflow: string; source: string; hash?: string };

type WriteWorkflowResult<Field extends string> =
  | { errors: FormErrors<Field>; written?: undefined }
  | { errors?: undefined; written: { path: string; hash: string } };

export const useWriteWorkflow = (repoId: number) => {
  const write = useSubmitMutation(api.repos.writeWorkflow.mutationOptions());
  const repo = { input: { id: repoId } };
  const refresh = useInvalidateQueries(api.repos.workflows.key(repo), api.repos.workflow.key(repo));

  return async <Field extends string>(
    input: WriteWorkflowInput,
    fields: readonly Field[],
  ): Promise<WriteWorkflowResult<Field>> => {
    const { error, data } = await write({ id: repoId, ...input });
    void refresh();
    if (error) return { errors: toFormErrors(error, fields) };
    return { written: data };
  };
};
