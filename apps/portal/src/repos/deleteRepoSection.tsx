import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Trash2Icon } from "lucide-react";

import { ActionButton } from "../actionButton";
import { api } from "../api";
import { PanelRow } from "../panelRow";
import { useInvalidateQueries } from "../useInvalidateQueries";

const description =
  "Halinka deletes the runs of the repo and their workspaces. The files of the repo stay.";

export type DeleteRepoSectionProps = { repoId: number; name: string };

export const DeleteRepoSection = (props: DeleteRepoSectionProps) => {
  const { repoId, name } = props;
  const refreshRepos = useInvalidateQueries(api.repos.list.key());
  const navigate = useNavigate();
  const deleteRepo = useMutation(
    api.repos.delete.mutationOptions({
      onSuccess: async () => {
        await refreshRepos();
        await navigate({ to: "/repos" });
      },
    }),
  );

  return (
    <PanelRow title="Delete the repo" description={description}>
      <ActionButton
        label="Delete repo"
        icon={<Trash2Icon />}
        confirm={{ title: `Delete the repo ${name}?`, description, keepLabel: "Keep repo" }}
        isPending={deleteRepo.isPending}
        error={deleteRepo.error}
        onClick={() => deleteRepo.mutate({ id: repoId })}
      />
    </PanelRow>
  );
};
