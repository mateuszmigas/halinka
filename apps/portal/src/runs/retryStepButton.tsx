import { useMutation } from "@tanstack/react-query";
import { RotateCcwIcon } from "lucide-react";

import { ActionButton } from "../actionButton";
import { api } from "../api";

export type RetryStepButtonProps = {
  workflowRunId: number;
  stepRunId: number;
  onRetried: () => void;
};

export const RetryStepButton = (props: RetryStepButtonProps) => {
  const { workflowRunId, stepRunId, onRetried } = props;
  const retry = useMutation(api.runs.retryStep.mutationOptions({ onSuccess: onRetried }));

  return (
    <ActionButton
      label="Try again"
      icon={<RotateCcwIcon />}
      pendingLabel="Starting…"
      isPending={retry.isPending}
      error={retry.error}
      onClick={() => retry.mutate({ id: workflowRunId, stepRunId })}
    />
  );
};
