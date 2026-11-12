import type { AttemptStatus, RunStatus, StepRunStatus } from "@halinka/server/client";
import { Badge } from "@halinka/ui/components/badge";
import type { ComponentProps } from "react";

import type { ToolCallStatus } from "./agentUpdate";

type Status = RunStatus | StepRunStatus | AttemptStatus | ToolCallStatus;

const statusVariant: Record<Status, ComponentProps<typeof Badge>["variant"]> = {
  queued: "secondary",
  pending: "secondary",
  running: "default",
  waiting_input: "warning",
  expired: "destructive",
  in_progress: "default",
  completed: "success",
  succeeded: "success",
  failed: "destructive",
  stopped: "destructive",
  cancelled: "secondary",
  skipped: "secondary",
  superseded: "secondary",
  lost: "destructive",
};

export type StatusLabelProps = { status: Status };

export const StatusLabel = (props: StatusLabelProps) => {
  const { status } = props;

  return (
    <Badge
      variant={statusVariant[status]}
      className={status === "superseded" ? "line-through" : undefined}
    >
      {status.replaceAll("_", " ")}
    </Badge>
  );
};
