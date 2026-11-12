import type { ReactNode } from "react";

export type PanelBodyProps = { children: ReactNode };

export const PanelBody = (props: PanelBodyProps) => {
  const { children } = props;

  return <div className="flex min-w-0 flex-col gap-4 p-4">{children}</div>;
};
