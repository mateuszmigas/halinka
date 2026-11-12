import type { ApiOutputs } from "@halinka/server/client";

import { DecisionItem } from "./decisionItem";
import { QuestionItem } from "./questionItem";

export type InboxItemProps = { item: ApiOutputs["inbox"]["resolve"]; closedText?: string };

export const InboxItem = (props: InboxItemProps) => {
  const { item, closedText } = props;

  if (item.kind === "question") return <QuestionItem item={item} closedText={closedText} />;
  return <DecisionItem item={item} closedText={closedText} />;
};
