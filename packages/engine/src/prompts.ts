import type { AgentTurn } from "@halinka/agents";
import type {
  AgentAnswer,
  AgentMessage,
  AgentQuestions,
  ReopenedStep,
  ToldToAgent,
} from "@halinka/protocol";
import { type AgentStep, canWrite } from "@halinka/workflow";

import type { AsData } from "./runDeps";

// `told`: the messages and answers that the agent got before, for a new session
export type BasePrompt = { isLoaded: boolean; isInterrupted: boolean; told: string[] };

type BasePromptOptions = { reopened?: ReopenedStep; reviewBase?: string; asData: AsData };

const reportInstructions =
  "When you complete the task, call the `report_result` tool one time. " +
  "Give a short summary of what you did or found. " +
  "Call it yourself, not from a sub-agent. The task is not complete until you call it. " +
  "If you need a decision or information that only a person can give, " +
  "call the `ask_human` tool, then end your turn.";

export const continuePrompt =
  "A person increased the limit that stopped you. " +
  "Continue the task, then call the `report_result` tool.";

const reminder = "You did not report your result. Call the `report_result` tool now.";

const attemptNote = (lead: string, step: AgentStep) =>
  [
    lead,
    ...(canWrite(step) ? ["The workspace can have changes from the earlier attempts."] : []),
  ].join(" ");

const interruptedNote = (step: AgentStep) =>
  attemptNote("The step stopped before it was complete.", step);

const reportProblemsReminder = (problems: string) =>
  `Your report is not valid:\n${problems}\nCall the \`report_result\` tool again with a valid report.`;

const questionProblemsReminder = (problems: string) =>
  `Halinka could not send your questions:\n${problems}\n` +
  "Call the `ask_human` tool again with valid questions, or call the `report_result` tool.";

export const reminderOf = ({ reportProblems, questionProblems }: AgentTurn) =>
  reportProblems
    ? reportProblemsReminder(reportProblems)
    : questionProblems
      ? questionProblemsReminder(questionProblems)
      : reminder;

export const answerPrompt = (questions: AgentQuestions, answer: AgentAnswer) =>
  [
    "A person answered your questions:",
    ...questions.map(({ question }, index) => {
      const { selected, other } = answer[index]!;
      const answered = [...selected, ...(other === null ? [] : [`Other: ${other}`])];
      return `${index + 1}. ${question}\n   Answer: ${answered.join("; ")}`;
    }),
  ].join("\n");

export const messagePrompt = ({ author, text }: Pick<AgentMessage, "author" | "text">) =>
  `Message from ${author}:\n${text}`;

export const toldPrompt = (entry: ToldToAgent) =>
  "text" in entry ? messagePrompt(entry) : answerPrompt(entry.questions, entry.answer);

export const toldNote = (count: number) =>
  `Halinka also gave the agent ${count} earlier messages and answers.`;

const reopenNote = (step: AgentStep) =>
  [
    "A person reopened this step.",
    ...(canWrite(step)
      ? ["The workspace has the changes of this step, without the changes of later steps."]
      : []),
    "The later steps run again after you report your result.",
  ].join(" ");

const changedFilesNote = (files: string[], count = files.length) =>
  `The files that you changed: ${files.join(", ")}` +
  (count > files.length ? `, and ${count - files.length} more` : "");

// A new session does not have the history, so it gets the step again.
type ReopenPromptOptions = { reopened: ReopenedStep; asData: AsData };

const reopenPrompt = (
  step: AgentStep,
  { isLoaded, isInterrupted, told }: BasePrompt,
  { reopened, asData }: ReopenPromptOptions,
) => {
  const { summary, outputs, changedFiles, changedFileCount } = reopened;
  return [
    ...(isLoaded
      ? []
      : [
          step.prompt,
          "You did this step before.",
          ...(summary ? [`Your summary:\n${asData(summary)}`] : []),
          ...(outputs ? [`Your outputs:\n${asData(JSON.stringify(outputs))}`] : []),
          ...(changedFiles ? [asData(changedFilesNote(changedFiles, changedFileCount))] : []),
          ...told,
        ]),
    reopenNote(step),
    ...(isInterrupted ? [interruptedNote(step)] : []),
    reportInstructions,
  ].join("\n\n");
};

// A loaded session has the step prompt in its history.
const firstPrompt = (step: AgentStep, { isLoaded, isInterrupted, told }: BasePrompt) =>
  [
    ...(isLoaded
      ? [attemptNote("Halinka continued this step after an interruption.", step)]
      : [step.prompt, ...told, ...(isInterrupted ? [interruptedNote(step)] : [])]),
    reportInstructions,
  ].join("\n\n");

const reviewBaseNote = (commit: string) =>
  `This run is on a pull request. Its changes start at the commit ${commit}: \`git diff ${commit}\` shows them. The default branch is not in the workspace.`;

export const basePrompt = (
  step: AgentStep,
  { reopened, reviewBase, asData }: BasePromptOptions,
  prompt: BasePrompt,
) =>
  [
    reopened ? reopenPrompt(step, prompt, { reopened, asData }) : firstPrompt(step, prompt),
    ...(reviewBase ? [reviewBaseNote(reviewBase)] : []),
  ].join("\n\n");
