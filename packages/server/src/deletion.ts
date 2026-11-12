import type { Repositories } from "./db/repositories";

// A revoked runner reports nothing more, so its runs are deleted at once.
export const deleteRunOfRevokedRunner = async (
  repositories: Repositories,
  { id, runnerId }: { id: number; runnerId: number | null },
) => {
  const runner = runnerId === null ? undefined : await repositories.runner.findById(runnerId);
  if (runner?.state !== "revoked") return false;
  await repositories.workflowRun.deleteDeleting(id);
  return true;
};

export const deleteRunIfGone = async (repositories: Repositories, workflowRunId: number) => {
  const run = await repositories.workflowRun.deleteIfGone(workflowRunId);
  if (run) await repositories.repo.deleteIfGone(run.repoId);
  return run !== undefined;
};
