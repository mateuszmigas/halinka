import { type RunEvent, textChunkOf } from "@halinka/server/client";
import { ChevronRightIcon } from "lucide-react";
import { memo } from "react";

import { type AgentUpdate, planOf, toolCallOf } from "./agentUpdate";
import { ChatMessage } from "./chatMessage";
import { StatusLabel } from "./statusLabel";

type AgentUpdateViewProps = { update: AgentUpdate };

const AgentUpdateView = (props: AgentUpdateViewProps) => {
  const { update } = props;

  const chunk = textChunkOf(update);
  if (chunk) {
    if (chunk.sessionUpdate === "agent_message_chunk") {
      return (
        <p className="whitespace-pre-wrap" data-testid="agent-text">
          {chunk.text}
        </p>
      );
    }
    return <p className="whitespace-pre-wrap text-muted-foreground italic">{chunk.text}</p>;
  }

  const toolCall = toolCallOf(update);
  if (toolCall) {
    const header = (
      <>
        {toolCall.status && <StatusLabel status={toolCall.status} />}
        <span className="min-w-0 truncate font-mono">{toolCall.title ?? toolCall.toolCallId}</span>
        {toolCall.kind && <span className="text-muted-foreground">{toolCall.kind}</span>}
      </>
    );
    if (toolCall.content.length === 0) {
      return <p className="flex items-center gap-2 px-3">{header}</p>;
    }
    const isActive = toolCall.status === "pending" || toolCall.status === "in_progress";
    return (
      <details open={isActive} className="group rounded-md border">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 hover:bg-muted">
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          {header}
        </summary>
        <div className="flex flex-col gap-1 border-t p-3">
          {toolCall.content.map((content, index) =>
            content.type === "diff" ? (
              <p key={index} className="font-mono text-muted-foreground">
                {content.path}
              </p>
            ) : (
              <pre
                key={index}
                className="max-h-60 overflow-auto rounded-md bg-muted p-3 font-mono whitespace-pre-wrap"
              >
                {content.text}
              </pre>
            ),
          )}
        </div>
      </details>
    );
  }

  const plan = planOf(update);
  if (plan) {
    if (plan.length === 0) return null;
    return (
      <ul className="flex flex-col gap-0.5">
        {plan.map((entry, index) => (
          <li key={index} className={entry.status === "completed" ? "text-muted-foreground" : ""}>
            <span className="mr-2 font-mono">{entry.status === "completed" ? "[x]" : "[ ]"}</span>
            {entry.content}
          </li>
        ))}
      </ul>
    );
  }

  return <p className="text-muted-foreground">{update.sessionUpdate}</p>;
};

type TranscriptEventProps = { event: RunEvent };

export const TranscriptEvent = memo((props: TranscriptEventProps) => {
  const { event } = props;
  const { kind } = event;

  switch (event.kind) {
    case "attempt_finished":
      return (
        <div>
          <p>
            <StatusLabel status={event.payload.status} />
            {event.payload.exitCode ? ` (exit ${event.payload.exitCode})` : null}
          </p>
          {event.payload.error && <p className="text-destructive">{event.payload.error}</p>}
          {event.payload.summary && <p className="whitespace-pre-wrap">{event.payload.summary}</p>}
        </div>
      );
    case "output":
      return (
        <pre
          className={`font-mono whitespace-pre-wrap ${event.payload.stream === "stderr" ? "text-destructive" : ""}`}
        >
          {event.payload.text}
        </pre>
      );
    case "output_cut":
      return (
        <p className="text-muted-foreground">
          Halinka left out {event.payload.length.toLocaleString()} characters of output here.
        </p>
      );
    case "gate_finished":
      return (
        <p className={event.payload.exitCode === 0 ? "text-muted-foreground" : "text-destructive"}>
          Gate <span className="font-mono">{event.payload.name}</span>:{" "}
          {event.payload.exitCode === undefined ? "failed" : `exit ${event.payload.exitCode}`}
        </p>
      );
    case "agent_session":
      return <p className="text-muted-foreground">Session {event.payload.sessionId}</p>;
    case "agent_prompt": {
      const { text, messages, answered } = event.payload;
      return (
        <>
          {answered && <p className="text-muted-foreground">Answer from {answered.author}</p>}
          {text && (
            <details>
              <summary className="cursor-pointer text-muted-foreground">Prompt</summary>
              <p className="mt-2 rounded-md bg-muted p-3 whitespace-pre-wrap">{text}</p>
            </details>
          )}
          {messages?.map(({ messageId, author, text }) => (
            <ChatMessage key={messageId} author={author} text={text} />
          ))}
        </>
      );
    }
    case "agent_update":
      return <AgentUpdateView update={event.payload.update} />;
    case "checkpoint":
      return (
        <p className="text-muted-foreground">
          Checkpoint <span className="font-mono">{event.payload.after.slice(0, 7)}</span>
        </p>
      );
    default:
      return <p className="text-muted-foreground">{kind}</p>;
  }
});
