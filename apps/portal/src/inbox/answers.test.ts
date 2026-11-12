import type { AgentQuestions } from "@halinka/server/client";
import { describe, expect, it } from "vitest";

import {
  type AnswerDraft,
  answerLines,
  checkOther,
  emptyDrafts,
  selectOption,
  selectOther,
  toAnswer,
  toggleOption,
} from "./answers";

type QuestionOptions = { isMultiSelect?: boolean };

const question = (
  header: string,
  options?: string[],
  { isMultiSelect = false }: QuestionOptions = {},
): AgentQuestions[number] => ({
  question: `${header}?`,
  header,
  options: options?.map((label) => ({ label, description: "" })),
  multiSelect: isMultiSelect,
});

const draft = (values: Partial<AnswerDraft> = {}): AnswerDraft => ({
  selected: [],
  isOtherChosen: false,
  other: "",
  ...values,
});

describe("answers", () => {
  it("chooses Other at the start of a question without options", () => {
    const questions = [question("Scope", ["A", "B"]), question("Name")];

    expect(emptyDrafts(questions)).toEqual([draft(), draft({ isOtherChosen: true })]);
  });

  it("replaces the option when a single choice gets an option", () => {
    const result = selectOption(draft({ selected: ["A"] }), "B");

    expect(result.selected).toEqual(["B"]);
  });

  it("clears Other when a single choice gets an option", () => {
    const result = selectOption(draft({ isOtherChosen: true }), "B");

    expect(result.isOtherChosen).toBe(false);
  });

  it("clears the option when a single choice gets Other", () => {
    const result = selectOther(draft({ selected: ["A"], other: "C" }));

    expect(result).toEqual(draft({ isOtherChosen: true, other: "C" }));
  });

  it("adds an option to a multiple choice", () => {
    const result = toggleOption(draft({ selected: ["A"] }), "B");

    expect(result.selected).toEqual(["A", "B"]);
  });

  it("keeps Other when a multiple choice gets an option", () => {
    const result = toggleOption(draft({ isOtherChosen: true }), "B");

    expect(result.isOtherChosen).toBe(true);
  });

  it("removes a chosen option from a multiple choice", () => {
    const result = toggleOption(draft({ selected: ["A", "B"] }), "A");

    expect(result).toEqual(draft({ selected: ["B"] }));
  });

  it("keeps the options when a multiple choice gets Other", () => {
    const result = checkOther(draft({ selected: ["A"] }), { isChecked: true });

    expect(result).toEqual(draft({ selected: ["A"], isOtherChosen: true }));
  });

  it("keeps the options when a multiple choice drops Other", () => {
    const result = checkOther(draft({ selected: ["A"], isOtherChosen: true }), {
      isChecked: false,
    });

    expect(result).toEqual(draft({ selected: ["A"] }));
  });

  it("drops the Other text when Other is not chosen", () => {
    const result = toAnswer([draft({ selected: ["A"], other: "text" })]);

    expect(result).toEqual([{ selected: ["A"], other: null }]);
  });

  it("trims the Other text", () => {
    const result = toAnswer([draft({ isOtherChosen: true, other: "  text  " })]);

    expect(result).toEqual([{ selected: [], other: "text" }]);
  });

  it("sends null for blank Other text", () => {
    const result = toAnswer([draft({ isOtherChosen: true, other: "  " })]);

    expect(result).toEqual([{ selected: [], other: null }]);
  });

  it("gives one line per question with the header, the options and the Other text", () => {
    const questions = [question("Scope", ["A", "B"], { isMultiSelect: true }), question("Name")];
    const answer = [
      { selected: ["A", "B"], other: "C" },
      { selected: [], other: "halinka" },
    ];

    expect(answerLines(questions, answer)).toEqual(["Scope: A, B, C", "Name: halinka"]);
  });
});
