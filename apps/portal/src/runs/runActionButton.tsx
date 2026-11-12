import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CircleStopIcon,
  GitPullRequestIcon,
  PlayIcon,
  SquareIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";

import { ActionButton, type ActionButtonProps } from "../actionButton";
import { api } from "../api";

type RunAction = Pick<ActionButtonProps, "label" | "icon" | "pendingLabel" | "confirm"> & {
  call: () => Promise<unknown>;
};

// The stream of the run page shows the result of each action, so no action refreshes a query.
const runActions = {
  cancel: (id: number): RunAction => ({
    label: "Cancel run",
    icon: <CircleStopIcon />,
    confirm: {
      title: `Cancel run #${id}?`,
      description: "The agents and commands of this run stop.",
      keepLabel: "Keep running",
    },
    call: () => api.runs.cancel.call({ id }),
  }),
  push: (id: number): RunAction => ({
    label: "Push branch",
    icon: <UploadIcon />,
    pendingLabel: "Pushing…",
    call: () => api.runs.push.call({ id }),
  }),
  openPullRequest: (id: number): RunAction => ({
    label: "Open PR",
    icon: <GitPullRequestIcon />,
    pendingLabel: "Opening…",
    call: () => api.runs.openPullRequest.call({ id }),
  }),
  startContainer: (id: number): RunAction => ({
    label: "Start container",
    icon: <PlayIcon />,
    call: () => api.runs.setSandbox.call({ id, spec: "running" }),
  }),
  stopContainer: (id: number): RunAction => ({
    label: "Stop container",
    icon: <SquareIcon />,
    call: () => api.runs.setSandbox.call({ id, spec: "stopped" }),
  }),
  removeWorkspace: (id: number): RunAction => ({
    label: "Remove workspace",
    icon: <Trash2Icon />,
    confirm: {
      title: `Remove the workspace of run #${id}?`,
      description:
        "The runner removes the workspace and its uncommitted files. The run branch stays.",
      keepLabel: "Keep workspace",
    },
    call: () => api.runs.removeSandbox.call({ id }),
  }),
  delete: (id: number): RunAction => ({
    label: "Delete run",
    icon: <Trash2Icon />,
    confirm: {
      title: `Delete run #${id}?`,
      description:
        "Halinka deletes the run, its transcript and its workspace. The run branch stays.",
      keepLabel: "Keep run",
    },
    call: () => api.runs.delete.call({ id }),
  }),
};

export type RunActionButtonProps = { action: keyof typeof runActions; workflowRunId: number };

export const RunActionButton = (props: RunActionButtonProps) => {
  const { action, workflowRunId } = props;
  const navigate = useNavigate();
  const { call, ...button } = runActions[action](workflowRunId);
  const mutation = useMutation({
    mutationFn: call,
    onSuccess: action === "delete" ? () => navigate({ to: "/runs" }) : undefined,
  });

  return (
    <ActionButton
      {...button}
      isPending={mutation.isPending}
      error={mutation.error}
      onClick={() => mutation.mutate()}
    />
  );
};
