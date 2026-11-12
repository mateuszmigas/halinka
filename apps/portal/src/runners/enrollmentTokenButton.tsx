import { Button } from "@halinka/ui/components/button";
import { useMutation, useQuery } from "@tanstack/react-query";

import { api } from "../api";
import { ErrorText } from "../errorText";
import { formatDateTime } from "../formatDateTime";

export type EnrollmentTokenButtonProps = {
  label: string;
  target: { labels: string[]; allowedAgents: string[] | null } | { runnerId: number };
  onCreated?: () => void;
};

// The token shows only here: the server keeps its hash.
export const EnrollmentTokenButton = (props: EnrollmentTokenButtonProps) => {
  const { label, target, onCreated } = props;
  const create = useMutation(
    api.runners.createEnrollmentToken.mutationOptions({ onSuccess: onCreated }),
  );
  const created = create.data;
  const { data: session } = useQuery(api.session.queryOptions());

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {!created && (
          <Button disabled={create.isPending} onClick={() => create.mutate(target)}>
            {label}
          </Button>
        )}
        <ErrorText error={create.error} />
      </div>
      {created && (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground">
            Run this command on the machine. The token works once, until{" "}
            {formatDateTime(created.expiresAt)}. It shows only now: copy it before you close this.
          </p>
          <code className="rounded-lg bg-muted p-2 font-mono break-all">
            {`HALINKA_ENROLL_TOKEN=${created.token} halinka runner --server ${session?.serverUrl ?? window.location.origin}`}
          </code>
        </div>
      )}
    </div>
  );
};
