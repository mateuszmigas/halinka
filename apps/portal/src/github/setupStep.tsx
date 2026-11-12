import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";

export type SetupStepState = "done" | "current" | "waiting";

const markClasses: Record<SetupStepState, string> = {
  done: "border-success bg-success text-background",
  current: "border-link bg-link/10 text-link",
  waiting: "text-muted-foreground",
};

export type SetupStepProps = {
  number: number;
  title: string;
  description: ReactNode;
  state: SetupStepState;
  children?: ReactNode;
};

export const SetupStep = (props: SetupStepProps) => {
  const { number, title, description, state, children } = props;

  return (
    <li aria-current={state === "current" ? "step" : undefined} className="flex gap-3 p-4">
      <span
        aria-hidden
        className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${markClasses[state]}`}
      >
        {state === "done" ? <CheckIcon className="size-3.5" /> : number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h3
            className={`text-sm font-medium ${state === "waiting" ? "text-muted-foreground" : ""}`}
          >
            {title}
            {state !== "current" && <span className="sr-only"> ({state})</span>}
          </h3>
          <p className="text-muted-foreground">{description}</p>
        </div>
        {state !== "waiting" && children}
      </div>
    </li>
  );
};
