import { useMutation } from "@tanstack/react-query";

import { ActionButton } from "../actionButton";
import { api } from "../api";
import { useInvalidateQueries } from "../useInvalidateQueries";

export type PublishDraftButtonProps = {
  repoId: number;
  path: string;
  source: string;
  baseHash: string;
};

export const PublishDraftButton = (props: PublishDraftButtonProps) => {
  const { repoId, path, source, baseHash } = props;
  const refreshWorkflow = useInvalidateQueries(api.repos.workflow.key({ input: { id: repoId } }));
  // A refused draft is stale: the editor then offers the way back.
  const publish = useMutation(
    api.repos.publishWorkflow.mutationOptions({ onError: refreshWorkflow }),
  );
  const isThisDraft =
    publish.variables?.source === source && publish.variables.baseHash === baseHash;

  return (
    <div className="flex items-center gap-2">
      {isThisDraft && publish.data && (
        <a href={publish.data.url} target="_blank" rel="noreferrer" className="underline">
          Draft pull request
        </a>
      )}
      <ActionButton
        label="Publish"
        pendingLabel="Publishing…"
        isPending={publish.isPending}
        error={isThisDraft ? publish.error : null}
        onClick={() => publish.mutate({ id: repoId, workflow: path, source, baseHash })}
      />
    </div>
  );
};
