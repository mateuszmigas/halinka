import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { tempFolder } from "@halinka/utils/testing";
import { type ReportShape, reportSchema } from "@halinka/workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { askHumanInputSchema, scriptShape } from "./fileReportChannel";

const serverPath = fileURLToPath(new URL("./reportResultServer.mjs", import.meta.url));

const questionSchema = {
  type: "object",
  properties: { questions: { type: "array" } },
  required: ["questions"],
};

const questionFileOf = (reportFile: string) => join(dirname(reportFile), "question.json");

const serverEnv = (reportFile: string, shape: ReportShape = {}) => ({
  ...process.env,
  HALINKA_REPORT_FILE: reportFile,
  HALINKA_REPORT_SHAPE: scriptShape(shape),
  HALINKA_QUESTION_FILE: questionFileOf(reportFile),
  HALINKA_QUESTION_SCHEMA: JSON.stringify(questionSchema),
});

const shape: ReportShape = {
  outcomes: { approve: "ok", reject: "fail" },
  outputs: {
    count: "number",
    files: { type: "array", items: "string" },
    review: { approved: "boolean", lines: { type: "array", items: { line: "number" } } },
  },
};

type RequestOptions = { params?: unknown; shape?: ReportShape };

describe("reportResultServer", () => {
  const sendLines = async <R = Record<string, unknown>>(
    reportFile: string,
    sent: string[],
    shape?: ReportShape,
  ) => {
    const server = spawn(process.execPath, [serverPath], { env: serverEnv(reportFile, shape) });
    const lines = createInterface({ input: server.stdout })[Symbol.asyncIterator]();
    for (const line of sent) server.stdin.write(`${line}\n`);
    const { value } = await lines.next();
    server.kill();
    return JSON.parse(value as string) as { result: R };
  };

  const requestLine = (method: string, params?: unknown) =>
    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

  const request = <R = Record<string, unknown>>(
    reportFile: string,
    method: string,
    { params, shape }: RequestOptions = {},
  ) => sendLines<R>(reportFile, [requestLine(method, params)], shape);

  const callReportResult = (reportFile: string, input: unknown, shape?: ReportShape) =>
    request<{ isError?: boolean; content: { text: string }[] }>(reportFile, "tools/call", {
      params: { name: "report_result", arguments: input },
      shape,
    });

  const callAskHuman = (reportFile: string, input: unknown) =>
    request<{ isError?: boolean; content: { text: string }[] }>(reportFile, "tools/call", {
      params: { name: "ask_human", arguments: input },
    });

  const listTool = async (name: string, shape?: ReportShape) => {
    const { result } = await request<{ tools: { name: string; inputSchema: unknown }[] }>(
      join(await tempFolder(), "report.json"),
      "tools/list",
      { shape },
    );
    return result.tools.find((tool) => tool.name === name);
  };

  it("lists ask_human with the question schema from the environment", async () => {
    const tool = await listTool("ask_human");

    expect(tool?.inputSchema).toEqual(questionSchema);
  });

  it.each<[string, ReportShape]>([
    ["a summary alone", {}],
    ["outcomes and outputs", shape],
  ])("lists report_result with the JSON Schema of the step report for %s", async (_, given) => {
    const { $schema: _schema, ...reportInputSchema } = z.toJSONSchema(reportSchema(given), {
      io: "output",
    });

    const tool = await listTool("report_result", given);

    expect(tool?.inputSchema).toEqual(reportInputSchema);
  });

  it("writes the questions to the question file", async () => {
    const folder = await tempFolder();
    const reportFile = join(folder, "report.json");
    const questions = [{ question: "Which database?", header: "Database" }];

    await callAskHuman(reportFile, { questions });

    const written = JSON.parse(await readFile(questionFileOf(reportFile), "utf8"));
    expect(written).toEqual({ questions });
  });

  it("answers with a tool error when it cannot write the questions", async () => {
    const folder = await tempFolder();
    const reportFile = join(folder, "missing", "report.json");

    const { result } = await callAskHuman(reportFile, {
      questions: [{ question: "Why?", header: "Reason" }],
    });

    expect(result.isError).toBe(true);
  });

  it("answers Unknown tool for a tool that it does not list", async () => {
    const folder = await tempFolder();
    const answer = await request(join(folder, "report.json"), "tools/call", {
      params: { name: "toString" },
    });

    expect(answer).toMatchObject({ error: { code: -32602, message: "Unknown tool" } });
  });

  const question = { question: "Which database?", header: "Database" };
  const options = [
    { label: "Postgres", description: "" },
    { label: "SQLite", description: "" },
  ];
  const withOptions = (...list: unknown[]) => ({ questions: [{ ...question, options: list }] });

  const refused: [string, unknown, string][] = [
    ["input that is not an object", "Why?", "Give an object with a `questions` list"],
    ["no questions", { questions: [] }, "Give a `questions` list of 1 to 4 questions"],
    ["five questions", { questions: Array(5).fill(question) }, "Give a `questions` list of 1 to 4"],
    ["an unknown key", { questions: [question], why: "" }, "Remove the unknown keys: why"],
    ["a question that is not an object", { questions: ["Why?"] }, "Question 1 is not an object"],
    [
      "a question with an unknown key",
      { questions: [{ ...question, id: 1 }] },
      "Question 1 has unknown keys: id",
    ],
    [
      "an empty question",
      { questions: [{ ...question, question: " " }] },
      "Question 1 needs a `question`",
    ],
    ["an empty header", { questions: [{ ...question, header: "" }] }, "needs a `header`"],
    ["a long header", { questions: [{ ...question, header: "A".repeat(13) }] }, "needs a `header`"],
    [
      "a header of 13 emoji",
      { questions: [{ ...question, header: "😀".repeat(13) }] },
      "needs a `header`",
    ],
    ["a text multiSelect", { questions: [{ ...question, multiSelect: "yes" }] }, "`multiSelect`"],
    ["one option", withOptions(options[0]), "2 to 4 `options`"],
    [
      "an option that is not an object",
      withOptions(options[0], "MySQL"),
      "option 2 is not an object",
    ],
    [
      "an option with an unknown key",
      withOptions(options[0], { ...options[1], id: 1 }),
      "option 2 has unknown keys: id",
    ],
    [
      "an option without a description",
      withOptions(options[0], { label: "MySQL" }),
      "option 2 needs a `description`",
    ],
    [
      "an option label of spaces",
      withOptions(options[0], { label: " ", description: "" }),
      "needs a `label`",
    ],
    [
      "a long option label",
      withOptions(options[0], { label: "A".repeat(61), description: "" }),
      "needs a `label`",
    ],
    [
      "two options with one label",
      withOptions(options[0], { ...options[0], label: " Postgres " }),
      "needs a different label",
    ],
  ];

  const accepted: [string, unknown][] = [
    ["four questions", { questions: Array(4).fill(question) }],
    ["a header of 12 characters", { questions: [{ ...question, header: "A".repeat(12) }] }],
    ["a header of 12 emoji", { questions: [{ ...question, header: "😀".repeat(12) }] }],
    [
      "four options with multiSelect",
      {
        questions: [
          {
            ...question,
            multiSelect: true,
            options: [
              ...options,
              { label: "MySQL", description: "" },
              { label: "A".repeat(60), description: "" },
            ],
          },
        ],
      },
    ],
  ];

  it.each(refused)("refuses %s", async (_, input, problem) => {
    const folder = await tempFolder();

    const { result } = await callAskHuman(join(folder, "report.json"), input);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(problem);
  });

  it.each(refused)("writes no question file for %s", async (_, input) => {
    const folder = await tempFolder();
    const reportFile = join(folder, "report.json");

    await callAskHuman(reportFile, input);

    await expect(access(questionFileOf(reportFile))).rejects.toThrow();
  });

  it.each(accepted)("writes %s", async (_, input) => {
    const folder = await tempFolder();
    const reportFile = join(folder, "report.json");

    await callAskHuman(reportFile, input);

    expect(JSON.parse(await readFile(questionFileOf(reportFile), "utf8"))).toEqual(input);
  });

  it("judges the questions as the runner does", () => {
    const passes = ([, input]: [string, unknown, ...unknown[]]) =>
      askHumanInputSchema.safeParse(input).success;

    expect({
      refused: refused.filter(passes),
      accepted: accepted.filter((row) => !passes(row)),
    }).toEqual({
      refused: [],
      accepted: [],
    });
  });

  it("writes the report to the report file", async () => {
    const folder = await tempFolder();
    const reportFile = join(folder, "report.json");

    await callReportResult(reportFile, { summary: "Done" });

    expect(JSON.parse(await readFile(reportFile, "utf8"))).toEqual({ summary: "Done" });
  });

  it("answers with a tool error when it cannot write the report", async () => {
    const folder = await tempFolder();
    const { result } = await callReportResult(join(folder, "missing", "report.json"), {
      summary: "Done",
    });

    expect(result.isError).toBe(true);
  });

  const outputs = { count: 2, files: ["a.ts"], review: { approved: true, lines: [{ line: 4 }] } };
  const valid = { summary: "Done", outcome: "approve", outputs };
  const withOutputs = (changed: Record<string, unknown>) => ({
    ...valid,
    outputs: { ...outputs, ...changed },
  });
  const { count: _, ...withoutCount } = outputs;

  const refusedReports: [string, unknown, string, ReportShape?][] = [
    ["a report that is not an object", "Done", "Give an object with a `summary`"],
    ["a report without a summary", { outcome: "approve", outputs }, "Give a `summary`"],
    ["an empty summary", { ...valid, summary: "" }, "Give a `summary`"],
    ["a summary that is not text", { ...valid, summary: 1 }, "Give a `summary`"],
    ["an unknown key", { ...valid, notes: "" }, "Remove the unknown keys: notes"],
    ["an outcome that is not declared", { ...valid, outcome: "merge" }, "one of: approve, reject"],
    ["a report without an outcome", { summary: "Done", outputs }, "one of: approve, reject"],
    ["a report without outputs", { summary: "Done", outcome: "approve" }, "`outputs` must be"],
    ["a missing output", { ...valid, outputs: withoutCount }, "Give `outputs.count`"],
    ["an unknown output", withOutputs({ size: 1 }), "`outputs` has unknown keys: size"],
    ["a text for a number", withOutputs({ count: "2" }), "`outputs.count` must be a number"],
    ["a text for a list", withOutputs({ files: "a.ts" }), "`outputs.files` must be a list"],
    ["a number in a text list", withOutputs({ files: [1] }), "`outputs.files[0]` must be a string"],
    ["a list for an object", withOutputs({ review: [] }), "`outputs.review` must be an object"],
    [
      "a wrong type in a nested object",
      withOutputs({ review: { approved: true, lines: [{ line: "4" }] } }),
      "`outputs.review.lines[0].line` must be a number",
    ],
    [
      "an outcome without declared outcomes",
      { summary: "Done", outcome: "approve" },
      "Remove the unknown keys: outcome",
      {},
    ],
    [
      "outputs without declared outputs",
      { summary: "Done", outputs: {} },
      "Remove the unknown keys: outputs",
      {},
    ],
  ];

  const acceptedReports: [string, unknown, ReportShape?][] = [
    ["a report of the declared shape", valid],
    ["empty lists", withOutputs({ files: [], review: { approved: false, lines: [] } })],
    ["a summary of spaces", { ...valid, summary: " " }],
    ["a summary alone", { summary: "Done" }, {}],
  ];

  it.each(refusedReports)("refuses %s", async (_, input, problem, given = shape) => {
    const folder = await tempFolder();

    const { result } = await callReportResult(join(folder, "report.json"), input, given);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(problem);
  });

  it.each(refusedReports)(
    "writes no report file for %s",
    async (_, input, _problem, given = shape) => {
      const folder = await tempFolder();
      const reportFile = join(folder, "report.json");

      await callReportResult(reportFile, input, given);

      await expect(access(reportFile)).rejects.toThrow();
    },
  );

  it.each(acceptedReports)("writes %s", async (_, input, given = shape) => {
    const folder = await tempFolder();
    const reportFile = join(folder, "report.json");

    await callReportResult(reportFile, input, given);

    expect(JSON.parse(await readFile(reportFile, "utf8"))).toEqual(input);
  });

  it("refuses a number that is not finite", async () => {
    const folder = await tempFolder();
    const reportFile = join(folder, "report.json");
    const call = requestLine("tools/call", { name: "report_result", arguments: {} }).replace(
      '"arguments":{}',
      '"arguments":{"summary":"Done","outputs":{"count":1e400}}',
    );

    const { result } = await sendLines<{ isError?: boolean }>(reportFile, [call], {
      outputs: { count: "number" },
    });

    expect(result.isError).toBe(true);
    await expect(access(reportFile)).rejects.toThrow();
  });

  it("answers the next request after a message of null", async () => {
    const folder = await tempFolder();
    const answer = await sendLines(join(folder, "report.json"), ["null", requestLine("ping")]);

    expect(answer).toMatchObject({ id: 1, result: {} });
  });

  it("judges the reports as the runner does", () => {
    const passes = (input: unknown, given = shape) =>
      reportSchema(given).safeParse(JSON.parse(JSON.stringify(input))).success;

    expect({
      refused: refusedReports.filter(([, input, , given]) => passes(input, given)),
      accepted: acceptedReports.filter(([, input, given]) => !passes(input, given)),
    }).toEqual({
      refused: [],
      accepted: [],
    });
  });

  it.each([
    "HALINKA_REPORT_FILE",
    "HALINKA_REPORT_SHAPE",
    "HALINKA_QUESTION_FILE",
    "HALINKA_QUESTION_SCHEMA",
  ])("exits when %s is not set", async (name) => {
    const folder = await tempFolder();
    const server = spawn(process.execPath, [serverPath], {
      env: { ...serverEnv(join(folder, "report.json")), [name]: "" },
    });

    const [code] = await once(server, "exit");

    expect(code).toBe(1);
  });
});
