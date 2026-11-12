import type { ApiOutputs } from "@halinka/server/client";

import { formatDateTime } from "../formatDateTime";
import { DecisionForm } from "./decisionForm";
import { decisionLabels } from "./decisionLabels";

type Item = Exclude<ApiOutputs["inbox"]["resolve"], { kind: "question" }>;

const outcomeOf = ({ decision, resolvedBy, note }: Item, closedText: string) => {
  if (decision === undefined) return closedText;
  return `${decisionLabels[decision].done} by ${resolvedBy}${note ? `: ${note}` : ""}`;
};

export type DecisionItemProps = { item: Item; closedText?: string };

export const DecisionItem = (props: DecisionItemProps) => {
  const { item, closedText = "Closed without a decision" } = props;

  return (
    <div className="flex flex-col gap-2">
      <p>{item.message}</p>
      {item.resolvedAt === undefined ? (
        <DecisionForm key={item.id} itemId={item.id} kind={item.kind} />
      ) : (
        <p className="text-muted-foreground">
          {outcomeOf(item, closedText)}
          <span className="ml-2">{formatDateTime(item.resolvedAt)}</span>
        </p>
      )}
    </div>
  );
};
