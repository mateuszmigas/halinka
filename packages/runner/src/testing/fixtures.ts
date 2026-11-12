import {
  type ClaimedRun,
  type ControlPlane,
  type RecordedStep,
  controlPlaneMethods,
} from "@halinka/protocol";
import { leaseOf } from "@halinka/protocol/testing";

export const claimedRun = (
  workflowRunId: number,
  overrides: Partial<ClaimedRun> = {},
): ClaimedRun =>
  ({
    lease: leaseOf(workflowRunId),
    repoPath: "/code/app",
    branch: `halinka/run-${workflowRunId}`,
    baseSha: "abc",
    definitionSha: "abc",
    sandboxKind: "worktree",
    agentVersions: {},
    agentModels: {},
    workflow: { name: "Test", steps: [{ id: "build", type: "shell", run: "ls" }] },
    inputs: {},
    steps: [],
    isUntrusted: false,
    isTestRun: false,
    lastCheckpoint: "abc",
    ...overrides,
  }) as ClaimedRun;

export const recordedStep: RecordedStep = {
  stepRunId: 1,
  stepId: "build",
  status: "succeeded",
  failedAttempts: 0,
};

// Each method that `overrides` does not give throws.
export const fakePlane = (overrides: Partial<ControlPlane> = {}): ControlPlane => {
  const notCalled = (name: string) => async () => {
    throw new Error(`The test does not expect a call of ${name}`);
  };
  const plane = Object.fromEntries(controlPlaneMethods.map((name) => [name, notCalled(name)]));
  return { ...plane, ...overrides } as ControlPlane;
};
