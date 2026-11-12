import { buttonVariants } from "@halinka/ui/components/button";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api";
import { vscodeSshUrl } from "./vscodeAttachUrl";

export type OpenOverSshButtonProps = { workflowRunId: number; folder: string };

export const OpenOverSshButton = (props: OpenOverSshButtonProps) => {
  const { workflowRunId, folder } = props;
  const { data: session } = useQuery(api.session.queryOptions());
  if (!session) return null;
  const { serverUrl } = session;

  return (
    <div className="flex flex-col gap-1">
      <a
        className={buttonVariants({ variant: "outline" })}
        href={vscodeSshUrl(serverUrl, workflowRunId, folder)}
        title="Install the Remote - SSH extension. Close the VS Code window before the run continues."
      >
        Open in VS Code
      </a>
      <code className="text-xs break-all text-muted-foreground">
        Once on your computer: halinka login --server {serverUrl} && halinka ssh config --server{" "}
        {serverUrl} {">>"} ~/.ssh/config
      </code>
    </div>
  );
};
