import { type AgentQuestions, answerProblem } from "@halinka/server/client";
import { Button } from "@halinka/ui/components/button";
import { useForm } from "@tanstack/react-form";
import { useId } from "react";

import { FormShell } from "../formShell";
import { emptyDrafts, toAnswer } from "./answers";
import { decisionLabels } from "./decisionLabels";
import { QuestionField } from "./questionField";
import { useResolveInboxItem } from "./useResolveInboxItem";

export type QuestionFormProps = { itemId: number; questions: AgentQuestions };

export const QuestionForm = (props: QuestionFormProps) => {
  const { itemId, questions } = props;
  const id = useId();
  const { resolve, refresh } = useResolveInboxItem();
  const form = useForm({
    defaultValues: { answers: emptyDrafts(questions) },
    validators: {
      onSubmitAsync: ({ value }) => {
        const answer = toAnswer(value.answers);
        const problem = answerProblem(questions, answer);
        if (problem) return { form: [{ message: problem }], fields: {} };
        return resolve({ id: itemId, answer });
      },
    },
    onSubmit: refresh,
  });

  return (
    <FormShell form={form}>
      {questions.map((question, index) => (
        <form.Field key={index} name={`answers[${index}]`}>
          {(field) => (
            <QuestionField
              id={`${id}-${index}`}
              question={question}
              draft={field.state.value}
              onChange={field.handleChange}
            />
          )}
        </form.Field>
      ))}
      <Button type="submit" className="w-fit">
        {decisionLabels.answered.action}
      </Button>
    </FormShell>
  );
};
