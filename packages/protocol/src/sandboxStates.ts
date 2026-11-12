// `destroyed`: the runner removes the container and the checkout.
export const sandboxSpecs = ["running", "stopped", "destroyed"] as const;
export type SandboxSpec = (typeof sandboxSpecs)[number];

export const sandboxStates = ["running", "stopped", "absent"] as const;
export type SandboxState = (typeof sandboxStates)[number];

// `devcontainer`: a container on a clone; `worktree`: a worktree on the runner's machine
export const sandboxKinds = ["devcontainer", "worktree"] as const;
export type SandboxKind = (typeof sandboxKinds)[number];
