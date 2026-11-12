import type { ReactNode } from "react";

export type StepChildrenProps = { children: ReactNode };

export const StepChildren = (props: StepChildrenProps) => {
  const { children } = props;

  return <div className="ml-4 flex flex-col border-l border-border pl-1.5">{children}</div>;
};
