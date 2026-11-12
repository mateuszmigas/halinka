import type { ApiOutputs } from "@halinka/server/client";
import { useId } from "react";

import { InboxItem } from "./inboxItem";

type RunDetail = ApiOutputs["runs"]["get"];

type RunItem = RunDetail["inboxItems"][number];

export type RunInboxItemProps = { item: RunItem; closedText?: string };

export const RunInboxItem = (props: RunInboxItemProps) => {
  const { item, closedText } = props;
  const labelId = useId();

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className="flex flex-col gap-2 rounded-lg border bg-card p-4"
    >
      <p id={labelId} className="font-mono">
        {item.stepId}
      </p>
      <InboxItem item={item} closedText={closedText} />
    </div>
  );
};
