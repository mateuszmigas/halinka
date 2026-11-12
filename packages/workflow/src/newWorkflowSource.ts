import { schemaVersion } from "./schemaVersion";

export const newWorkflowSource = (file: string) => {
  const name = JSON.stringify(file.replace(/\.ya?ml$/, ""));
  return `schema_version: ${schemaVersion}\nname: ${name}\nsteps:\n  - id: hello\n    type: shell\n    run: echo hello\n`;
};
