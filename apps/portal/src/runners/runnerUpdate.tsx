import type { ApiOutputs } from "@halinka/server/client";
import { Badge } from "@halinka/ui/components/badge";
import { useMutation } from "@tanstack/react-query";

import { ActionButton } from "../actionButton";
import { api } from "../api";
import { useIsAdmin } from "../login/useIsAdmin";
import { useInvalidateQueries } from "../useInvalidateQueries";

type RunnerRow = ApiOutputs["runners"]["list"][number];

export type RunnerUpdateProps = { runner: RunnerRow };

const heldRunsText = (heldRunIds: number[]) =>
  heldRunIds.length === 0
    ? "It restarts at its next sync."
    : `It waits for run ${heldRunIds.join(", ")}.`;

export const RunnerUpdate = (props: RunnerUpdateProps) => {
  const { runner } = props;
  const isAdmin = useIsAdmin();
  const onSuccess = useInvalidateQueries(api.runners.list.key());
  const request = useMutation(api.runners.requestUpdate.mutationOptions({ onSuccess }));
  const cancel = useMutation(api.runners.cancelUpdate.mutationOptions({ onSuccess }));
  const settings = useMutation(api.runners.update.mutationOptions({ onSuccess }));
  const { id, buildStatus, canUpdate, updateRequest, heldRunIds, hasAutoUpdate, updateFailure } =
    runner;
  const isOld = buildStatus === "outdated" || buildStatus === "update_needed";

  if (!isAdmin || runner.state === "revoked") return null;
  if (!canUpdate) {
    return isOld ? (
      <span className="text-muted-foreground text-sm">
        Update it on its machine: halinka runner install
      </span>
    ) : null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {updateFailure && !updateRequest && (
        <span className="text-destructive text-sm">The last update failed: {updateFailure}</span>
      )}
      {updateRequest ? (
        <>
          <Badge variant="warning">updating</Badge>
          <span className="text-muted-foreground text-sm">{heldRunsText(heldRunIds)}</span>
          {updateRequest === "when_idle" && heldRunIds.length > 0 && (
            <ActionButton
              label="Interrupt and update"
              size="sm"
              confirm={{
                title: `Interrupt the runs of ${runner.name}?`,
                description:
                  "The runner stops its runs now and restarts with the build of the server. The runs go back to the queue: an approval stays open, and an agent question closes and the agent asks again.",
                keepLabel: "Wait for the runs",
              }}
              isPending={request.isPending}
              error={request.error}
              onClick={() => request.mutate({ id, isNow: true })}
            />
          )}
          <ActionButton
            label="Cancel update"
            size="sm"
            isPending={cancel.isPending}
            error={cancel.error}
            onClick={() => cancel.mutate({ id })}
          />
        </>
      ) : (
        isOld && (
          <ActionButton
            label="Update"
            size="sm"
            isPending={request.isPending}
            error={request.error}
            onClick={() => request.mutate({ id, isNow: false })}
          />
        )
      )}
      <ActionButton
        label={hasAutoUpdate ? "Turn off auto-update" : "Turn on auto-update"}
        size="sm"
        isPending={settings.isPending}
        error={settings.error}
        onClick={() => settings.mutate({ id, hasAutoUpdate: !hasAutoUpdate })}
      />
    </div>
  );
};
