import type { AgentAnswer, AgentQuestions } from "@halinka/server/client";

export type AnswerDraft = { selected: string[]; isOtherChosen: boolean; other: string };

type CheckOtherOptions = { isChecked: boolean };

export const emptyDrafts = (questions: AgentQuestions): AnswerDraft[] =>
  questions.map(({ options }) => ({
    selected: [],
    isOtherChosen: options === undefined,
    other: "",
  }));

export const selectOption = (draft: AnswerDraft, label: string): AnswerDraft => ({
  ...draft,
  selected: [label],
  isOtherChosen: false,
});

export const selectOther = (draft: AnswerDraft): AnswerDraft => ({
  ...draft,
  selected: [],
  isOtherChosen: true,
});

export const toggleOption = (draft: AnswerDraft, label: string): AnswerDraft => ({
  ...draft,
  selected: draft.selected.includes(label)
    ? draft.selected.filter((selectedLabel) => selectedLabel !== label)
    : [...draft.selected, label],
});

export const checkOther = (draft: AnswerDraft, { isChecked }: CheckOtherOptions): AnswerDraft => ({
  ...draft,
  isOtherChosen: isChecked,
});

export const toAnswer = (drafts: AnswerDraft[]): AgentAnswer =>
  drafts.map(({ selected, isOtherChosen, other }) => ({
    selected,
    other: isOtherChosen ? other.trim() || null : null,
  }));

export const answerLines = (questions: AgentQuestions, answer: AgentAnswer) =>
  questions.map(({ header }, index) => {
    const { selected, other } = answer[index]!;
    return `${header}: ${(other === null ? selected : [...selected, other]).join(", ")}`;
  });
