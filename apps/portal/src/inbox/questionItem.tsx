import type { ApiOutputs } from "@halinka/server/client";

import { formatDateTime } from "../formatDateTime";
import { answerLines } from "./answers";
import { QuestionForm } from "./questionForm";

type Item = Extract<ApiOutputs["inbox"]["resolve"], { kind: "question" }>;

export type QuestionItemProps = { item: Item; closedText?: string };

export const QuestionItem = (props: QuestionItemProps) => {
  const { item, closedText = "Closed without an answer" } = props;

  if (item.resolvedAt === undefined) {
    return <QuestionForm key={item.id} itemId={item.id} questions={item.questions} />;
  }
  return (
    <div className="text-muted-foreground">
      <p>
        {item.answer === undefined ? closedText : `Answered by ${item.resolvedBy}`}
        <span className="ml-2">{formatDateTime(item.resolvedAt)}</span>
      </p>
      {item.answer !== undefined && (
        <ul>
          {answerLines(item.questions, item.answer).map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
};
