import type { ApiOutputs } from "@halinka/server/client";

type Sandbox = NonNullable<ApiOutputs["runs"]["get"]["sandbox"]>;

// The container terms match the Start and Stop buttons.
const observedLabels = {
  devcontainer: { running: "Started", stopped: "Stopped", absent: "Missing" },
  worktree: { running: "Kept", stopped: "Kept", absent: "Missing" },
} as const;

const pendingLabels = {
  devcontainer: { running: "Starting", stopped: "Stopping" },
  worktree: { running: "Checking", stopped: "Checking" },
} as const;

export const workspaceLabel = (sandbox: Sandbox | undefined) => {
  if (!sandbox) return undefined;
  const { kind, spec, observed, isInUse, isPending, error } = sandbox;
  if (isInUse) return "In use";
  if (spec === "destroyed") return isPending ? "Removing" : "Removed";
  if (error) return "Failed";
  if (isPending || !observed) return pendingLabels[kind][spec];
  return observedLabels[kind][observed];
};
