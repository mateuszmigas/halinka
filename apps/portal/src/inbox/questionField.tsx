import type { AgentQuestions } from "@halinka/server/client";
import { Checkbox } from "@halinka/ui/components/checkbox";
import { Input } from "@halinka/ui/components/input";
import { Label } from "@halinka/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@halinka/ui/components/radio-group";
import { Textarea } from "@halinka/ui/components/textarea";

import { type AnswerDraft, checkOther, selectOption, selectOther, toggleOption } from "./answers";

type Option = NonNullable<AgentQuestions[number]["options"]>[number];

const otherValue = "other";

export type QuestionFieldProps = {
  id: string;
  question: AgentQuestions[number];
  draft: AnswerDraft;
  onChange: (draft: AnswerDraft) => void;
};

export const QuestionField = (props: QuestionFieldProps) => {
  const { id, question, draft, onChange } = props;
  const { options, multiSelect } = question;
  const questionId = `${id}-question`;
  const changeOther = (other: string) => {
    const typed = { ...draft, other };
    onChange(multiSelect ? checkOther(typed, { isChecked: true }) : selectOther(typed));
  };

  const optionLabel = ({ label, description }: Option, index: number) => (
    <Label htmlFor={`${id}-${index}`} className="flex flex-col font-normal">
      <span className="font-medium">{label}</span>
      {description && <span className="text-muted-foreground">{description}</span>}
    </Label>
  );
  const otherInput = (
    <Input
      aria-label="Other"
      placeholder="Other"
      value={draft.other}
      onChange={(event) => changeOther(event.target.value)}
      className="max-w-sm"
    />
  );

  const body = () => {
    if (options === undefined) {
      return (
        <Textarea
          aria-labelledby={questionId}
          rows={2}
          value={draft.other}
          onChange={(event) => changeOther(event.target.value)}
        />
      );
    }
    if (!multiSelect) {
      const selectedIndex = options.findIndex(({ label }) => label === draft.selected[0]);
      return (
        <RadioGroup
          aria-labelledby={questionId}
          value={draft.isOtherChosen ? otherValue : selectedIndex < 0 ? "" : String(selectedIndex)}
          onValueChange={(value) =>
            onChange(
              value === otherValue
                ? selectOther(draft)
                : selectOption(draft, options[Number(value)]!.label),
            )
          }
        >
          {options.map((option, index) => (
            <div key={option.label} className="flex items-start gap-2">
              <RadioGroupItem id={`${id}-${index}`} value={String(index)} className="mt-0.5" />
              {optionLabel(option, index)}
            </div>
          ))}
          <div className="flex items-center gap-2">
            <RadioGroupItem value={otherValue} aria-label="Choose Other" />
            {otherInput}
          </div>
        </RadioGroup>
      );
    }
    return (
      <div role="group" aria-labelledby={questionId} className="flex flex-col gap-2">
        {options.map((option, index) => (
          <div key={option.label} className="flex items-start gap-2">
            <Checkbox
              id={`${id}-${index}`}
              checked={draft.selected.includes(option.label)}
              onCheckedChange={() => onChange(toggleOption(draft, option.label))}
              className="mt-0.5"
            />
            {optionLabel(option, index)}
          </div>
        ))}
        <div className="flex items-center gap-2">
          <Checkbox
            aria-label="Choose Other"
            checked={draft.isOtherChosen}
            onCheckedChange={(checked) =>
              onChange(checkOther(draft, { isChecked: checked === true }))
            }
          />
          {otherInput}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <p id={questionId}>
        <span className="mr-2 rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium">
          {question.header}
        </span>
        {question.question}
      </p>
      {body()}
    </div>
  );
};
