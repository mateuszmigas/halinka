export const runSshPath = (workflowRunId: number) => `/api/runs/${workflowRunId}/ssh`;

export const workflowRunIdOfSshPath = (path: string) => {
  const id = /^\/api\/runs\/(\d{1,15})\/ssh$/.exec(path)?.[1];
  return id === undefined ? undefined : Number(id);
};
