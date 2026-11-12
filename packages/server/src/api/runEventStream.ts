import { AsyncIteratorClass, withEventMeta } from "@orpc/server";

import type { RunStream } from "../runStream";

// A reconnecting client continues after its `Last-Event-ID`.
export const startSeq = (lastEventId: string | undefined, after: number) => {
  const seq = Number(lastEventId);
  return lastEventId && Number.isSafeInteger(seq) && seq >= 0 ? seq : after;
};

// `checkAccess`: a member that an Admin removes gets nothing more from an open stream.
export const toEventIterator = (
  stream: RunStream,
  signal: AbortSignal | undefined,
  checkAccess: () => Promise<void>,
) => {
  // A client that closes before the response starts only aborts `signal`.
  if (signal?.aborted) stream.stop();
  signal?.addEventListener("abort", () => stream.stop(), { once: true });
  return new AsyncIteratorClass(
    async () => {
      const result = await stream.next();
      if (!result.done) await checkAccess();
      if (result.done || result.value.type !== "events") return result;
      const id = result.value.events.at(-1)?.seq;
      return { ...result, value: withEventMeta(result.value, { id: String(id) }) };
    },
    async () => stream.stop(),
  );
};
