import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";

import { abortError, isAbortError } from "@halinka/utils/errors";

import {
  type ExecOptions,
  type ExecResult,
  type SandboxProcess,
  maxStderrTailChars,
  outputLimitCode,
} from "./sandbox";

export type StartedProcess = { child: ChildProcessWithoutNullStreams; stopped: Promise<void> };

export const checkedCommand = ([file, ...args]: string[], signal?: AbortSignal) => {
  if (!file) throw new Error("Command is empty");
  if (signal?.aborted) throw abortError();
  return { file, args };
};

// The engine reads an AbortError as a stop of the turn, so a limit must not look like one.
export const execWithin = async (
  command: string[],
  options: ExecOptions,
  exec: (options: ExecOptions) => Promise<ExecResult>,
) => {
  const { timeoutMs, maxOutputChars, signal, onOutput } = options;
  if (timeoutMs === undefined && maxOutputChars === undefined) return exec(options);
  const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  const outputLimit = maxOutputChars ?? Infinity;
  const tooLong = new AbortController();
  let outputLength = 0;
  const signals = [signal, timeout, tooLong.signal].filter((item) => item !== undefined);
  try {
    return await exec({
      ...options,
      signal: AbortSignal.any(signals),
      onOutput: (chunk, stream) => {
        outputLength += chunk.length;
        if (outputLength > outputLimit) tooLong.abort();
        onOutput?.(chunk, stream);
      },
    });
  } catch (error) {
    if (!isAbortError(error) || signal?.aborted) throw error;
    if (timeout?.aborted) {
      const message = `The sandbox did not end \`${command[0]}\` in ${timeoutMs! / 1000} s`;
      throw new Error(message, { cause: error });
    }
    if (!tooLong.signal.aborted) throw error;
    const message = `The output of \`${command[0]}\` is longer than ${maxOutputChars} characters`;
    throw Object.assign(new Error(message, { cause: error }), { code: outputLimitCode });
  }
};

export const collectOutput = (
  { child, stopped }: StartedProcess,
  { onOutput, signal, isOutputKept = true }: ExecOptions,
) =>
  new Promise<ExecResult>((resolve, reject) => {
    child.stdin.destroy();
    const output = { stdout: "", stderr: "" };
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream].setEncoding("utf8").on("data", (chunk: string) => {
        onOutput?.(chunk, stream);
        // After an abort, `exec` rejects: do not hold more output.
        if (signal?.aborted) return;
        if (isOutputKept) output[stream] += chunk;
        else if (stream === "stderr")
          output.stderr = (output.stderr + chunk).slice(-maxStderrTailChars);
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      stopped.then(() => {
        if (signal?.aborted) reject(abortError());
        else resolve({ exitCode: code ?? 1, ...output });
      }, reject);
    });
  });

export const toSandboxProcess = async ({
  child,
  stopped,
}: StartedProcess): Promise<SandboxProcess> => {
  const exited = new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
  await once(child, "spawn");
  return {
    stdin: Writable.toWeb(child.stdin),
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
    exited,
    stopped,
  };
};
