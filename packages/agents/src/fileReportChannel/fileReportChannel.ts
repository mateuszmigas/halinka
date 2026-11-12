import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { McpServerStdio } from "@agentclientprotocol/sdk";
import { agentQuestionsSchema } from "@halinka/protocol";
import { type Sandbox, sandboxCallTimeoutMs } from "@halinka/sandbox";
import type { Result } from "@halinka/utils/result";
import {
  outcomeNames,
  type ReportSchema,
  reportSchema,
  reportServerName,
  type ReportShape,
} from "@halinka/workflow";
import { z } from "zod";

import type { ReportChannel, TurnReport } from "../agent";

export const askHumanInputSchema = z.strictObject({ questions: agentQuestionsSchema });

const fileContentSchema = z.union([z.string(), z.strictObject({ problem: z.string() })]);

const refuse = (problem: string): Result<never> => ({ ok: false, problems: [problem] });

const parseJson = <T>(
  schema: z.ZodType<T>,
  file: z.infer<typeof fileContentSchema>,
  what: string,
): Result<T> => {
  if (typeof file !== "string") return refuse(`The ${what} ${file.problem}`);
  let input: unknown;
  try {
    input = JSON.parse(file);
  } catch {
    return refuse(`The ${what} is not JSON`);
  }
  const result = schema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : refuse(z.prettifyError(result.error));
};

const parseReport = (schema: ReportSchema, file: z.infer<typeof fileContentSchema>): TurnReport => {
  const parsed = parseJson(schema, file, "report");
  return parsed.ok ? { report: parsed.value } : { reportProblems: parsed.problems.join("\n") };
};

const parseQuestions = (file: z.infer<typeof fileContentSchema>): TurnReport => {
  const parsed = parseJson(askHumanInputSchema, file, "question");
  return parsed.ok
    ? { questions: parsed.value.questions }
    : { questionProblems: parsed.problems.join("\n") };
};

const { $schema: _, ...questionInputSchema } = z.toJSONSchema(askHumanInputSchema, { io: "input" });
const questionSchema = JSON.stringify(questionInputSchema);

const callOptions = { timeoutMs: sandboxCallTimeoutMs };

const maxFileBytes = 1024 * 1024;

// The agent user can write the folder, and this read runs as the remote user.
const readFilesScript = `
const { constants, fstatSync, openSync, readSync, unlinkSync } = require("node:fs");
const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const read = (file) => {
  let fd;
  try {
    fd = openSync(file, flags);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error.code === "ELOOP") return { problem: "is a link" };
    return { problem: \`cannot be opened (\${error.code})\` };
  }
  const stats = fstatSync(fd);
  if (!stats.isFile()) return { problem: "is not a regular file" };
  if (stats.nlink > 1) return { problem: "has more than one link" };
  const buffer = Buffer.allocUnsafe(${maxFileBytes} + 1);
  let length = 0;
  let count;
  do {
    count = readSync(fd, buffer, length, buffer.length - length, null);
    length += count;
  } while (count > 0 && length < buffer.length);
  if (length > ${maxFileBytes}) return { problem: "is larger than 1 MiB" };
  return buffer.toString("utf8", 0, length);
};
const remove = (file) => {
  try {
    unlinkSync(file);
    return [];
  } catch (error) {
    return error.code === "ENOENT" ? [] : [error];
  }
};
const files = process.argv.slice(1);
try {
  process.stdout.write(JSON.stringify(files.map(read)));
} finally {
  const [failure] = files.flatMap(remove);
  if (failure) throw failure;
}
`;

const fileContentsSchema = z.array(fileContentSchema.nullable());

// Linux limits the size of one environment variable.
const maxShapeBytes = 64 * 1024;

export const scriptShape = ({ outcomes, outputs }: ReportShape) => {
  const shape = JSON.stringify({ outcomes: outcomes && outcomeNames(outcomes), outputs });
  if (Buffer.byteLength(shape) > maxShapeBytes) {
    throw new Error("The report shape of the step is larger than 64 KiB. Declare fewer outputs");
  }
  return shape;
};

// The agent user writes the folder in the sandbox, so it is 0777 and its files need `exec`.
export class FileReportChannel implements ReportChannel {
  readonly mcpServer: McpServerStdio;
  private readonly schema: ReportSchema;
  private readonly server: string;
  private readonly reportFile: string;
  private readonly questionFile: string;

  private constructor(
    private readonly sandbox: Sandbox,
    private readonly folder: string,
    reportShape: ReportShape,
  ) {
    this.schema = reportSchema(reportShape);
    this.server = `${folder}/report-result.mjs`;
    this.reportFile = `${folder}/report.json`;
    this.questionFile = `${folder}/question.json`;
    this.mcpServer = {
      name: reportServerName,
      command: "node",
      args: [this.server],
      env: [
        { name: "HALINKA_REPORT_FILE", value: this.reportFile },
        { name: "HALINKA_REPORT_SHAPE", value: scriptShape(reportShape) },
        { name: "HALINKA_QUESTION_FILE", value: this.questionFile },
        { name: "HALINKA_QUESTION_SCHEMA", value: questionSchema },
      ],
    };
  }

  static async create(this: void, sandbox: Sandbox, reportShape: ReportShape) {
    const channel = new FileReportChannel(sandbox, `/tmp/halinka/${randomUUID()}`, reportShape);
    await channel.install();
    return channel;
  }

  // It deletes the files for the next turn; an aborted turn can still give a report.
  async read(): Promise<TurnReport> {
    const { exitCode, stdout, stderr } = await this.sandbox.exec(
      ["node", "-e", readFilesScript, this.reportFile, this.questionFile],
      callOptions,
    );
    if (exitCode !== 0) throw new Error(`Halinka could not read the report: ${stderr.trim()}`);
    const parsed = parseJson(fileContentsSchema, stdout, "output of the read");
    if (!parsed.ok) {
      throw new Error(`Halinka could not read the report: ${parsed.problems.join("\n")}`);
    }
    const [report, question] = parsed.value;
    return {
      ...(report != null && parseReport(this.schema, report)),
      ...(question != null && parseQuestions(question)),
    };
  }

  async close() {
    await this.sandbox.exec(["rm", "-rf", this.folder], callOptions);
  }

  private async install() {
    const source = await readFile(new URL("./reportResultServer.mjs", import.meta.url), "utf8");
    const { exitCode, stderr } = await this.sandbox.exec(
      [
        "sh",
        "-c",
        'mkdir -p "$(dirname "$0")" && chmod 0777 "$(dirname "$0")" && printf %s "$HALINKA_SERVER" > "$0"',
        this.server,
      ],
      { env: { HALINKA_SERVER: source }, ...callOptions },
    );
    if (exitCode !== 0) {
      await this.close();
      throw new Error(`Halinka could not install the report server: ${stderr.trim()}`);
    }
  }
}
