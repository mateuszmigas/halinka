import { z } from "zod";

import { attemptResults } from "./controlPlane";

const ofAttempt = { stepId: z.string(), attemptId: z.number() };

const runEventOf = <K extends string, P extends z.ZodRawShape>(kind: K, payload: P) =>
  z.object({ kind: z.literal(kind), payload: z.object({ ...ofAttempt, ...payload }) });

const acpSessionUpdateSchema = z.looseObject({ sessionUpdate: z.string() });

export const runEventSchema = z.discriminatedUnion("kind", [
  runEventOf("attempt_started", { stepRunId: z.number(), attempt: z.number() }),
  runEventOf("attempt_finished", {
    status: z.enum(attemptResults),
    exitCode: z.number().optional(),
    error: z.string().optional(),
    summary: z.string().optional(),
  }),
  runEventOf("output", {
    stream: z.enum(["stdout", "stderr"]),
    text: z.string(),
    gate: z.string().optional(),
  }),
  // the engine left out `length` characters of the output of a process here
  runEventOf("output_cut", { length: z.number(), gate: z.string().optional() }),
  runEventOf("gate_finished", { name: z.string(), exitCode: z.number().optional() }),
  // `replacedCostUsd`: the cost of the attempt in the sessions that this session replaced
  runEventOf("agent_session", {
    sessionId: z.string(),
    replacedCostUsd: z.number().nonnegative().optional(),
  }),
  runEventOf("agent_prompt", {
    text: z.string(),
    // `text` without the messages; only with `messages`
    baseText: z.string().optional(),
    messages: z
      .array(z.object({ messageId: z.number(), author: z.string(), text: z.string() }))
      .optional(),
    // the question item that the prompt answers
    answered: z.object({ itemId: z.number(), author: z.string() }).optional(),
  }),
  runEventOf("agent_update", { update: acpSessionUpdateSchema }),
  runEventOf("checkpoint", { before: z.string(), after: z.string() }),
]);

export type RunEvent = z.infer<typeof runEventSchema>;

type AgentUpdate = Extract<RunEvent, { kind: "agent_update" }>["payload"]["update"];

const textChunkKinds = ["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"];

export const textChunkOf = (update: AgentUpdate) => {
  if (!textChunkKinds.includes(update.sessionUpdate)) return undefined;
  const { content } = update as { content?: { type?: unknown; text?: unknown } | null };
  return content?.type === "text" && typeof content.text === "string"
    ? { sessionUpdate: update.sessionUpdate, text: content.text }
    : undefined;
};

const absentSchema = z.null().optional();

// Strict, so a merged chunk keeps every field of both chunks.
const textChunkSchema = z.strictObject({
  sessionUpdate: z.enum(["agent_message_chunk", "agent_thought_chunk"]),
  messageId: z.string(),
  content: z.strictObject({
    type: z.literal("text"),
    text: z.string(),
    annotations: absentSchema,
    _meta: absentSchema,
  }),
  _meta: absentSchema,
});

type EventOf<K extends RunEvent["kind"]> = Extract<RunEvent, { kind: K }>;

const maxOutputCharacters = 64 * 1024;

const mergeOutputs = (previous: EventOf<"output">, next: EventOf<"output">) => {
  const { payload } = previous;
  if (
    payload.stream !== next.payload.stream ||
    payload.gate !== next.payload.gate ||
    payload.text.length + next.payload.text.length > maxOutputCharacters
  ) {
    return undefined;
  }
  return { ...previous, payload: { ...payload, text: payload.text + next.payload.text } };
};

const mergeChunks = (previous: EventOf<"agent_update">, next: EventOf<"agent_update">) => {
  const second = textChunkSchema.safeParse(next.payload.update);
  if (!second.success) return undefined;
  const first = textChunkSchema.safeParse(previous.payload.update);
  if (
    !first.success ||
    first.data.sessionUpdate !== second.data.sessionUpdate ||
    first.data.messageId !== second.data.messageId
  ) {
    return undefined;
  }
  const { data: chunk } = first;
  const text = chunk.content.text + second.data.content.text;
  const update = { ...chunk, content: { ...chunk.content, text } };
  return { ...previous, payload: { ...previous.payload, update } };
};

export const mergeRunEvents = (previous: RunEvent, next: RunEvent): RunEvent | undefined => {
  if (
    previous.payload.stepId !== next.payload.stepId ||
    previous.payload.attemptId !== next.payload.attemptId
  ) {
    return undefined;
  }
  if (previous.kind === "output" && next.kind === "output") return mergeOutputs(previous, next);
  if (previous.kind === "agent_update" && next.kind === "agent_update") {
    return mergeChunks(previous, next);
  }
  return undefined;
};
