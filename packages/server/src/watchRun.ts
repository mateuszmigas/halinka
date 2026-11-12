import { isDefinedError } from "@orpc/client";

import type { ApiOutputs, StoredRunEvent } from "./client";

type RunChange = ApiOutputs["runs"]["watch"] extends AsyncIterable<infer Change> ? Change : never;

export type WatchRunOptions = {
  watch: (
    input: { id: number; after: number },
    options: { signal: AbortSignal },
  ) => Promise<AsyncIterable<RunChange>>;
  workflowRunId: number;
  signal: AbortSignal;
  reconnectDelayMs?: number;
  pollMs?: number;
  onEvents: (events: StoredRunEvent[]) => void;
  onState: () => void;
};

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });

// Resolves with the error of the contract that ends the watch, or with undefined after an abort.
export const watchRun = async (options: WatchRunOptions): Promise<Error | undefined> => {
  const { watch, workflowRunId, signal, reconnectDelayMs = 2000, pollMs = 30_000 } = options;
  const { onEvents, onState } = options;
  let after = 0;
  // A stream can hang with no error and no end, so the state is also read at an interval.
  const poll = setInterval(onState, pollMs);

  try {
    // A proxy can end the stream without an error.
    while (!signal.aborted) {
      try {
        for await (const change of await watch({ id: workflowRunId, after }, { signal })) {
          if (change.type === "state") {
            onState();
            continue;
          }
          after = change.events.at(-1)?.seq ?? after;
          onEvents(change.events);
        }
      } catch (error) {
        if (signal.aborted) return undefined;
        if (isDefinedError(error)) return error;
      }
      await wait(reconnectDelayMs, signal);
    }
    return undefined;
  } finally {
    clearInterval(poll);
  }
};
