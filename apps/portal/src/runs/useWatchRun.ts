import { watchRun } from "@halinka/server/client";
import { useEffect, useEffectEvent, useState } from "react";

import { api } from "../api";
import { useInvalidateQueries } from "../useInvalidateQueries";
import { Transcript, type TranscriptItem } from "./transcript";

export const useWatchRun = (workflowRunId: number) => {
  // A state change can open or close an inbox item of the run.
  const refresh = useInvalidateQueries(
    api.runs.get.key({ input: { id: workflowRunId } }),
    api.inbox.list.key(),
  );
  const onState = useEffectEvent(() => void refresh());
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [error, setError] = useState<Error>();

  useEffect(() => {
    const controller = new AbortController();
    const transcript = new Transcript();
    void watchRun({
      watch: (input, options) => api.runs.watch.call(input, options),
      workflowRunId,
      signal: controller.signal,
      onEvents: (events) => setItems(transcript.add(events)),
      onState: () => onState(),
    }).then(setError);
    return () => controller.abort();
  }, [workflowRunId]);

  return { items, error };
};
