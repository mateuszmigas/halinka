import { type RunEvent, textChunkOf } from "@halinka/server/client";
import { isRecord } from "@halinka/utils/isRecord";

export type AgentUpdate = Extract<RunEvent, { kind: "agent_update" }>["payload"]["update"];

const toolCallStatuses = ["pending", "in_progress", "completed", "failed"] as const;
export type ToolCallStatus = (typeof toolCallStatuses)[number];

type ToolCallContent = { type: "text"; text: string } | { type: "diff"; path: string };

type ToolCall = {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: ToolCallStatus;
  content: ToolCallContent[];
};

const planEntryStatuses = ["pending", "in_progress", "completed"] as const;
type PlanEntryStatus = (typeof planEntryStatuses)[number];

type PlanEntry = { content: string; status: PlanEntryStatus };

const isToolCallStatus = (value: unknown): value is ToolCallStatus =>
  (toolCallStatuses as readonly unknown[]).includes(value);

const isPlanEntryStatus = (value: unknown): value is PlanEntryStatus =>
  (planEntryStatuses as readonly unknown[]).includes(value);

const stringOf = (value: unknown) => (typeof value === "string" ? value : undefined);

const toolCallContentOf = (value: unknown): ToolCallContent | undefined => {
  if (!isRecord(value)) return undefined;
  if (value.type === "diff" && typeof value.path === "string") {
    return { type: "diff", path: value.path };
  }
  if (value.type === "content" && isRecord(value.content) && value.content.type === "text") {
    const text = stringOf(value.content.text);
    return text === undefined ? undefined : { type: "text", text };
  }
  return undefined;
};

export const toolCallIdOf = (update: AgentUpdate) =>
  update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update"
    ? stringOf(update.toolCallId)
    : undefined;

export const toolCallOf = (update: AgentUpdate): ToolCall | undefined => {
  const toolCallId = toolCallIdOf(update);
  if (toolCallId === undefined) return undefined;
  const content = Array.isArray(update.content) ? update.content : [];
  return {
    toolCallId,
    title: stringOf(update.title),
    kind: stringOf(update.kind),
    status: isToolCallStatus(update.status) ? update.status : undefined,
    content: content.flatMap((item) => toolCallContentOf(item) ?? []),
  };
};

export const planOf = (update: AgentUpdate): PlanEntry[] | undefined => {
  if (update.sessionUpdate !== "plan" || !Array.isArray(update.entries)) return undefined;
  return update.entries.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const content = stringOf(entry.content);
    const { status } = entry;
    return content !== undefined && isPlanEntryStatus(status) ? [{ content, status }] : [];
  });
};

const isSystemUpdate = (update: AgentUpdate) =>
  textChunkOf(update) === undefined &&
  toolCallOf(update) === undefined &&
  planOf(update) === undefined;

export const isSystemEvent = (event: RunEvent) =>
  event.kind === "agent_session" ||
  (event.kind === "agent_update" && isSystemUpdate(event.payload.update));
