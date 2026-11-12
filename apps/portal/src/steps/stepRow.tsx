import type { ReactNode } from "react";

const rowClassName = "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left";
const toneClassNames = {
  default: { row: "", id: "" },
  muted: { row: "", id: "text-muted-foreground" },
  attention: { row: "bg-warning/10", id: "font-semibold" },
};

export type StepRowProps = {
  icon: ReactNode;
  stepId: string;
  detail?: ReactNode;
  tags?: ReactNode;
  tone?: keyof typeof toneClassNames;
  isSelected?: boolean;
  onSelect?: () => void;
};

export const StepRow = (props: StepRowProps) => {
  const { icon, stepId, detail, tags, tone = "default", isSelected = false, onSelect } = props;
  const toneClassName = toneClassNames[tone];
  const content = (
    <>
      {icon}
      <span className={`min-w-0 shrink truncate font-mono ${toneClassName.id}`}>{stepId}</span>
      {detail && (
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{detail}</span>
      )}
      {tags && <span className="ml-auto flex shrink-0 gap-1">{tags}</span>}
    </>
  );

  if (!onSelect) return <div className={`${rowClassName} ${toneClassName.row}`}>{content}</div>;
  return (
    <button
      type="button"
      aria-current={isSelected ? "step" : undefined}
      onClick={onSelect}
      className={`${rowClassName} ${toneClassName.row} hover:bg-muted aria-[current=step]:bg-primary/10`}
    >
      {content}
    </button>
  );
};
