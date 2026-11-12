import type { ApiOutputs } from "@halinka/server/client";

import type { TranscriptItem } from "./transcript";

type WaitingRun = {
  undeliveredMessages: ApiOutputs["runs"]["get"]["undeliveredMessages"];
  stepRuns: { id: number; status: string }[];
};

// The run detail can be older than the events: a prompt can carry a message that it still lists.
export const waitingMessages = (
  { undeliveredMessages, stepRuns }: WaitingRun,
  items: TranscriptItem[],
) => {
  const delivered = new Set(
    items.flatMap(({ event }) =>
      event.kind === "agent_prompt"
        ? (event.payload.messages ?? []).map(({ messageId }) => messageId)
        : [],
    ),
  );
  const running = new Set(
    stepRuns.filter(({ status }) => status === "running").map(({ id }) => id),
  );
  return undeliveredMessages
    .filter(({ id }) => !delivered.has(id))
    .map((message) => ({ ...message, isWaiting: running.has(message.stepRunId) }));
};

export type WaitingMessage = ReturnType<typeof waitingMessages>[number];
