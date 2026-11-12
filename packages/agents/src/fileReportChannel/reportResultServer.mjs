// The agent runs this file alone in the sandbox, so import only Node built-ins.
import { renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const reportFile = process.env.HALINKA_REPORT_FILE;
const reportShape = process.env.HALINKA_REPORT_SHAPE;
const questionFile = process.env.HALINKA_QUESTION_FILE;
const questionSchema = process.env.HALINKA_QUESTION_SCHEMA;
if (!reportFile || !reportShape || !questionFile || !questionSchema) {
  process.stderr.write(
    "Set HALINKA_REPORT_FILE, HALINKA_REPORT_SHAPE, HALINKA_QUESTION_FILE and HALINKA_QUESTION_SCHEMA\n",
  );
  process.exit(1);
}
const { outcomes, outputs } = JSON.parse(reportShape);

// Keep this schema equal to `z.toJSONSchema` of `reportSchema` in @halinka/workflow.
const objectSchema = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const typeSchema = (type) => {
  if (typeof type === "string") return { type };
  if (type.type === "array") return { type: "array", items: typeSchema(type.items) };
  return fieldsSchema(type);
};

const fieldsSchema = (fields) =>
  objectSchema(
    Object.fromEntries(Object.entries(fields).map(([name, type]) => [name, typeSchema(type)])),
  );

const reportResult = {
  name: "report_result",
  description:
    "Report the result of your task to Halinka. Call it one time, at the end. " +
    "The task is not complete until you call it.",
  inputSchema: objectSchema({
    summary: {
      type: "string",
      minLength: 1,
      description: "A short summary of what you did or found",
    },
    ...(outcomes && {
      outcome: {
        type: "string",
        enum: outcomes,
        description: "The outcome of your task: one of the listed values",
      },
    }),
    ...(outputs && {
      outputs: { ...fieldsSchema(outputs), description: "The data that your task asks for" },
    }),
  }),
};

const askHuman = {
  name: "ask_human",
  description:
    "Ask a person 1 to 4 questions when you need a decision or information that only a person can give. " +
    "Give each question 2 to 4 options, or no options for a text answer. " +
    "The person can always type other text. End your turn after the call: the answer comes in the next message.",
  inputSchema: JSON.parse(questionSchema),
};

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

const toolError = (text) => ({ content: [{ type: "text", text }], isError: true });

const notReported = (reason) => toolError(`Halinka did not get your result: ${reason}`);

const writeAtomic = (file, input) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(input));
  renameSync(`${file}.tmp`, file);
};

const notAsked = (reason) => toolError(`Halinka did not send your questions: ${reason}`);

// Keep these rules equal to `agentQuestionsSchema` in @halinka/protocol.
// Zod counts code points, not UTF-16 units.
const lengthOf = (text) => [...text.trim()].length;

const isText = (value, max = Infinity) =>
  typeof value === "string" && lengthOf(value) > 0 && lengthOf(value) <= max;

const unknownKeys = (value, keys) => Object.keys(value).filter((key) => !keys.includes(key));

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const optionProblem = (option) => {
  if (!isObject(option)) return "is not an object";
  const extra = unknownKeys(option, ["label", "description"]);
  if (extra.length > 0) return `has unknown keys: ${extra.join(", ")}`;
  if (!isText(option.label, 60)) return "needs a `label` of 1 to 60 characters";
  if (typeof option.description !== "string") return "needs a `description`";
  return null;
};

const questionProblem = (question) => {
  if (!isObject(question)) return "is not an object";
  const extra = unknownKeys(question, ["question", "header", "options", "multiSelect"]);
  if (extra.length > 0) return `has unknown keys: ${extra.join(", ")}`;
  if (!isText(question.question)) return "needs a `question` that is not empty";
  if (!isText(question.header, 12)) return "needs a `header` of 1 to 12 characters";
  if (question.multiSelect !== undefined && typeof question.multiSelect !== "boolean") {
    return "needs a `multiSelect` that is true or false";
  }
  const { options } = question;
  if (options === undefined) return null;
  if (!Array.isArray(options) || options.length < 2 || options.length > 4) {
    return "needs 2 to 4 `options`, or no `options`";
  }
  for (const [index, option] of options.entries()) {
    const problem = optionProblem(option);
    if (problem) return `option ${index + 1} ${problem}`;
  }
  if (new Set(options.map(({ label }) => label.trim())).size !== options.length) {
    return "needs a different label for each option";
  }
  return null;
};

const questionsProblem = (input) => {
  if (!isObject(input)) return "Give an object with a `questions` list";
  const extra = unknownKeys(input, ["questions"]);
  if (extra.length > 0) return `Remove the unknown keys: ${extra.join(", ")}`;
  const { questions } = input;
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) {
    return "Give a `questions` list of 1 to 4 questions";
  }
  for (const [index, question] of questions.entries()) {
    const problem = questionProblem(question);
    if (problem) return `Question ${index + 1} ${problem}`;
  }
  return null;
};

// Keep these rules equal to `reportSchema` in @halinka/workflow.
const isType = (value, type) =>
  type === "number" ? Number.isFinite(value) : typeof value === type;

const typeProblem = (value, type, path) => {
  if (typeof type === "string") return isType(value, type) ? null : `\`${path}\` must be a ${type}`;
  if (type.type !== "array") return fieldsProblem(value, type, path);
  if (!Array.isArray(value)) return `\`${path}\` must be a list`;
  for (const [index, item] of value.entries()) {
    const problem = typeProblem(item, type.items, `${path}[${index}]`);
    if (problem) return problem;
  }
  return null;
};

const fieldsProblem = (value, fields, path) => {
  if (!isObject(value)) return `\`${path}\` must be an object`;
  const extra = Object.keys(value).filter((key) => !Object.hasOwn(fields, key));
  if (extra.length > 0) return `\`${path}\` has unknown keys: ${extra.join(", ")}`;
  for (const [name, type] of Object.entries(fields)) {
    if (!Object.hasOwn(value, name)) return `Give \`${path}.${name}\``;
    const problem = typeProblem(value[name], type, `${path}.${name}`);
    if (problem) return problem;
  }
  return null;
};

const reportProblem = (input) => {
  if (!isObject(input)) return "Give an object with a `summary`";
  const keys = ["summary", ...(outcomes ? ["outcome"] : []), ...(outputs ? ["outputs"] : [])];
  const extra = unknownKeys(input, keys);
  if (extra.length > 0) return `Remove the unknown keys: ${extra.join(", ")}`;
  if (typeof input.summary !== "string" || input.summary === "") {
    return "Give a `summary` that is not empty";
  }
  if (outcomes && !outcomes.includes(input.outcome)) {
    return `Give an \`outcome\` that is one of: ${outcomes.join(", ")}`;
  }
  return outputs ? fieldsProblem(input.outputs, outputs, "outputs") : null;
};

const report = (input) => {
  const problem = reportProblem(input);
  if (problem) return notReported(`${problem}, then call \`report_result\` again.`);
  try {
    writeAtomic(reportFile, input);
  } catch (error) {
    return notReported(error.message);
  }
  return { content: [{ type: "text", text: "Halinka has your result. Stop now." }] };
};

const ask = (input) => {
  const problem = questionsProblem(input);
  if (problem) return notAsked(`${problem}, then call \`ask_human\` again.`);
  try {
    writeAtomic(questionFile, input);
  } catch (error) {
    return notAsked(error.message);
  }
  return {
    content: [
      { type: "text", text: "Halinka sent your questions to a person. End your turn now." },
    ],
  };
};

const tools = [
  { tool: reportResult, call: report },
  { tool: askHuman, call: ask },
];

const answer = ({ method, params }) => {
  switch (method) {
    case "initialize":
      return {
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "halinka", version: "1" },
        },
      };
    case "ping":
      return { result: {} };
    case "tools/list":
      return { result: { tools: tools.map(({ tool }) => tool) } };
    case "tools/call": {
      const called = tools.find(({ tool }) => tool.name === params?.name);
      return called
        ? { result: called.call(params.arguments) }
        : { error: { code: -32602, message: "Unknown tool" } };
    }
    default:
      return { error: { code: -32601, message: "Method not found" } };
  }
};

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message?.id !== undefined) send({ id: message.id, ...answer(message) });
});
