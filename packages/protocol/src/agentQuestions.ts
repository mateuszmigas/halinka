import { z } from "zod";

const optionSchema = z.strictObject({
  label: z.string().trim().min(1).max(60),
  description: z.string().trim(),
});

// Without `options`, a person answers with text only.
const agentQuestionSchema = z
  .strictObject({
    question: z.string().trim().min(1),
    header: z.string().trim().min(1).max(12),
    options: z.array(optionSchema).min(2).max(4).optional(),
    multiSelect: z.boolean().default(false),
  })
  .refine(
    ({ options = [] }) => new Set(options.map(({ label }) => label)).size === options.length,
    { message: "Give each option of a question a different label", path: ["options"] },
  );

export const agentQuestionsSchema = z.array(agentQuestionSchema).min(1).max(4);
export type AgentQuestions = z.output<typeof agentQuestionsSchema>;

// One entry per question, in order; `other`: the text of the "Other" choice
export const agentAnswerSchema = z.array(
  z.strictObject({
    selected: z.array(z.string()),
    other: z
      .string()
      .trim()
      .nullable()
      .transform((other) => other || null),
  }),
);
export type AgentAnswer = z.output<typeof agentAnswerSchema>;

const choiceProblem = (
  { options = [], multiSelect }: AgentQuestions[number],
  { selected, other }: AgentAnswer[number],
) => {
  const labels = new Set(options.map(({ label }) => label));
  const unknown = selected.find((label) => !labels.has(label));
  if (unknown !== undefined) return `has no option "${unknown}"`;
  if (new Set(selected).size !== selected.length) return "selects an option twice";
  if (!multiSelect && selected.length > 1) return "takes one option";
  if (selected.length === 0 && other === null) return "needs an option or other text";
  return undefined;
};

export const answerProblem = (questions: AgentQuestions, answer: AgentAnswer) => {
  if (answer.length !== questions.length) {
    return "Give one answer for each question";
  }
  for (const [index, question] of questions.entries()) {
    const problem = choiceProblem(question, answer[index]!);
    if (problem) return `Question ${index + 1} ${problem}`;
  }
  return undefined;
};
