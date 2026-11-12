const muted = "bg-muted text-muted-foreground";
const kindStyles: Record<string, { glyph: string; className: string }> = {
  agent: { glyph: "✦", className: "bg-primary/10 text-primary" },
  shell: { glyph: "⌘", className: muted },
  approval: { glyph: "✓", className: "bg-success/10 text-success" },
  github: { glyph: "⎇", className: muted },
  loop: { glyph: "↻", className: muted },
};
const unknownKind = { glyph: "?", className: muted };

export type StepKindIconProps = { kind: string; className?: string };

export const StepKindIcon = (props: StepKindIconProps) => {
  const { kind, className = "size-5 rounded text-xs" } = props;
  const style = Object.hasOwn(kindStyles, kind) ? kindStyles[kind]! : unknownKind;

  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center ${className} ${style.className}`}
    >
      {style.glyph}
    </span>
  );
};
