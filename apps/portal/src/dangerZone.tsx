import type { ReactNode } from "react";

import { Panel } from "./panel";

export type DangerZoneProps = { children: ReactNode };

export const DangerZone = (props: DangerZoneProps) => {
  const { children } = props;

  return (
    <Panel title="Danger zone" isDestructive>
      <div className="divide-y">{children}</div>
    </Panel>
  );
};
