import { Card } from "@halinka/ui/components/card";
import type { ReactNode } from "react";

export type PanelProps = {
  title: string;
  count?: number;
  action?: ReactNode;
  hasHeader?: boolean;
  isDestructive?: boolean;
  children: ReactNode;
};

export const Panel = (props: PanelProps) => {
  const { title, count, action, hasHeader = true, isDestructive = false, children } = props;

  return (
    <Card
      data-slot="panel"
      role="region"
      aria-label={title}
      className={`min-w-0 gap-0 py-0 ${isDestructive ? "ring-destructive/40" : ""}`}
    >
      {hasHeader && (
        <header className="flex min-h-10 flex-wrap items-center gap-2 border-b px-4 py-1">
          <h2 className={`text-sm font-semibold ${isDestructive ? "text-destructive" : ""}`}>
            {title}
          </h2>
          {count !== undefined && <span className="text-muted-foreground">{count}</span>}
          {action && <div className="ml-auto">{action}</div>}
        </header>
      )}
      {children}
    </Card>
  );
};
