const prefixOf = (server: string) =>
  `halinka-${new URL(server).host.replace(/[^a-zA-Z0-9.-]+/g, "-")}-`;

// The names of a server's runs in `~/.ssh/config`.
export const sshHostPattern = (server: string) => `${prefixOf(server)}*`;

export const sshHostOf = (server: string, workflowRunId: number) =>
  `${prefixOf(server)}${workflowRunId}`;

// `halinka ssh` also takes the bare id. The `*` of the pattern matches any text, so only digits pass.
export const parseSshHostWorkflowRunId = (host: string, server: string) => {
  const prefix = prefixOf(server);
  const id = host.startsWith(prefix) ? host.slice(prefix.length) : host;
  return /^\d{1,15}$/.test(id) ? Number(id) : undefined;
};
