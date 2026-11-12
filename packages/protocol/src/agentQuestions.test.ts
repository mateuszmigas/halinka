import { describe, expect, it } from "vitest";

import { type AgentQuestions, agentQuestionsSchema, answerProblem } from "./agentQuestions";

const options = [
  { label: "Lint", description: "Run the linter" },
  { label: "Tests", description: "Run the tests" },
];

const checks: AgentQuestions = [
  { question: "Which checks?", header: "Checks", options, multiSelect: true },
];

const database: AgentQuestions = [
  { ...checks[0]!, question: "Which database?", header: "Database", multiSelect: false },
];

const textOnly: AgentQuestions = [{ question: "What name?", header: "Name", multiSelect: false }];

describe("agentQuestionsSchema", () => {
  it("refuses two options with one label", () => {
    const duplicate = [
      { question: "Which checks?", header: "Checks", options: [options[0], options[0]] },
    ];

    expect(agentQuestionsSchema.safeParse(duplicate).success).toBe(false);
  });

  it("takes many options of a multiSelect question", () => {
    expect(answerProblem(checks, [{ selected: ["Lint", "Tests"], other: null }])).toBeUndefined();
  });

  it("refuses an option that the answer selects twice", () => {
    expect(answerProblem(checks, [{ selected: ["Lint", "Lint"], other: null }])).toBe(
      "Question 1 selects an option twice",
    );
  });

  it("refuses two options for a question that takes one", () => {
    expect(answerProblem(database, [{ selected: ["Lint", "Tests"], other: null }])).toBe(
      "Question 1 takes one option",
    );
  });

  it("refuses an answer with no option and no other text", () => {
    expect(answerProblem(checks, [{ selected: [], other: null }])).toBe(
      "Question 1 needs an option or other text",
    );
  });

  it("refuses an answer list of another length than the questions", () => {
    expect(answerProblem(checks, [])).toBe("Give one answer for each question");
  });

  it("takes other text as the answer of a question without options", () => {
    expect(answerProblem(textOnly, [{ selected: [], other: "halinka" }])).toBeUndefined();
  });

  it("refuses an option for a question without options", () => {
    expect(answerProblem(textOnly, [{ selected: ["Lint"], other: null }])).toBe(
      'Question 1 has no option "Lint"',
    );
  });
});
