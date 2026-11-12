import { useQuery } from "@tanstack/react-query";

import { api } from "../api";
import { statusPollMs } from "../statusPollMs";

export const usePendingInboxCount = () =>
  useQuery({
    ...api.inbox.list.queryOptions(),
    refetchInterval: statusPollMs,
    select: (items) => items.length,
  }).data ?? 0;
