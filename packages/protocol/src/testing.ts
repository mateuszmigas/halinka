import type { Build, RunLease, SyncRequest } from "./controlPlane";

export const leaseOf = (workflowRunId: number): RunLease => ({
  workflowRunId,
  lease: `lease-${workflowRunId}`,
});

export const testBuild: Build = { version: "0.0.1", id: "test-build" };

export const testSyncRequest: SyncRequest = {
  held: [],
  capacity: 1,
  capabilities: {
    sandboxKind: "worktree",
    build: testBuild,
    canUpdate: false,
    agentsOnPath: [],
  },
};
