// What an Admin sets on a runner. `draining`: it claims no new runs; `revoked`: its key is refused.
export const runnerStates = ["active", "draining", "revoked"] as const;

// `when_idle`: the runner restarts into the build of the server when it holds no run; `now`: at once.
export const runnerUpdateRequests = ["when_idle", "now"] as const;
export type RunnerUpdateRequest = (typeof runnerUpdateRequests)[number];
