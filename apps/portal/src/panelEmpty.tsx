import type { ReactNode } from "react";

export type PanelEmptyProps = { children: ReactNode };

export const PanelEmpty = (props: PanelEmptyProps) => {
  const { children } = props;

  return <p className="px-4 py-3 text-muted-foreground">{children}</p>;
};
