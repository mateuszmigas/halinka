export const workflowsFolder = ".halinka/workflows/";
const workflowNamePattern = /^[a-z0-9][a-z0-9_-]*$/i;
const workflowPathPattern = /^\.halinka\/workflows\/[^/]+\.ya?ml$/;

export const isWorkflowPath = (path: string) => workflowPathPattern.test(path);

// a bare name gives no path: it can be .yml or .yaml
export const toWorkflowPath = (workflow: string) => {
  if (isWorkflowPath(workflow)) return workflow;
  if (isWorkflowPath(workflowsFolder + workflow)) return workflowsFolder + workflow;
  return undefined;
};

const workflowPathsOf = (workflow: string) => {
  const path = toWorkflowPath(workflow);
  if (path) return [path];
  if (!workflowNamePattern.test(workflow)) return [];
  return [`${workflowsFolder}${workflow}.yml`, `${workflowsFolder}${workflow}.yaml`];
};

export const isWorkflowRef = (workflow: string) => workflowPathsOf(workflow).length > 0;

export const findWorkflowFile = <File>(files: Record<string, File>, workflow: string) => {
  for (const path of workflowPathsOf(workflow)) {
    const file = files[path];
    if (file !== undefined) return { path, file };
  }
  return undefined;
};
