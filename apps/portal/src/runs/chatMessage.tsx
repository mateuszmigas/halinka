import type { ReactNode } from "react";

export type ChatMessageProps = { author: string; text: string; status?: ReactNode };

export const ChatMessage = (props: ChatMessageProps) => {
  const { author, text, status } = props;

  return (
    <div className="ml-auto flex max-w-prose flex-col gap-1 rounded-lg border bg-muted/50 p-3">
      <p className="text-muted-foreground">
        {author}
        {status && <span className="ml-2">· {status}</span>}
      </p>
      <p className="whitespace-pre-wrap">{text}</p>
    </div>
  );
};
