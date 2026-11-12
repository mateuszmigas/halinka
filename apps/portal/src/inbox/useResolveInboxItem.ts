import { api } from "../api";
import { toFormErrors } from "../formErrors";
import { useInvalidateQueries } from "../useInvalidateQueries";
import { useSubmitMutation } from "../useSubmitMutation";

type ResolveInput = Parameters<typeof api.inbox.resolve.call>[0];

export const useResolveInboxItem = () => {
  const resolveItem = useSubmitMutation(api.inbox.resolve.mutationOptions());
  // The inbox page has no stream of the run.
  const refresh = useInvalidateQueries(api.inbox.list.key());
  const resolve = async (input: ResolveInput) => {
    const { error } = await resolveItem(input);
    if (!error) return undefined;
    // A refusal means the item changed on the server.
    void refresh();
    return toFormErrors(error, []);
  };

  return { resolve, refresh };
};
