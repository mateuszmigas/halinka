import type { StepRunStatus } from "@halinka/server/client";

type IconStatus = StepRunStatus | "not_started";

const muted = "bg-muted text-muted-foreground";
const statusIcons: Record<IconStatus, { glyph: string; className: string }> = {
  running: {
    glyph: "",
    className:
      "border-2 border-primary/25 border-t-primary animate-spin motion-reduce:animate-none",
  },
  succeeded: { glyph: "✓", className: "bg-success/15 text-success" },
  failed: { glyph: "✕", className: "bg-destructive text-background" },
  cancelled: { glyph: "✕", className: muted },
  skipped: { glyph: "–", className: muted },
  superseded: { glyph: "↺", className: muted },
  not_started: { glyph: "", className: "border border-dashed border-input" },
};
const waitingIcon = { glyph: "!", className: "bg-warning text-card" };

export type StepStatusIconProps = { status: IconStatus; isWaiting?: boolean };

export const StepStatusIcon = (props: StepStatusIconProps) => {
  const { status, isWaiting = false } = props;
  const icon = isWaiting ? waitingIcon : statusIcons[status];
  const label = status.replaceAll("_", " ");

  return (
    <span
      className={`grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-bold ${icon.className}`}
    >
      <span aria-hidden="true">{icon.glyph}</span>
      <span className="sr-only">{isWaiting ? `${label}, waits for you` : label}</span>
    </span>
  );
};
