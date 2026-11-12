import type { ReactNode } from "react";

export type PanelRowProps = {
  title: string;
  description?: ReactNode;
  children: ReactNode;
};

export const PanelRow = (props: PanelRowProps) => {
  const { title, description, children } = props;

  return (
    <section aria-label={title} className="flex flex-wrap items-center gap-x-8 gap-y-3 p-4">
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
        <h3 className="font-medium">{title}</h3>
        {description && <p className="text-muted-foreground">{description}</p>}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">{children}</div>
    </section>
  );
};
