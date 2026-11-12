import { networkHosts, type ShellStep } from "@halinka/workflow";

import { MaskedStream } from "./maskedStream";
import { type OutputChunk, OutputLimit } from "./outputLimit";
import type { OutputTail } from "./outputTail";
import type { StepContext } from "./runDeps";

// `of`: the ids that each output event carries
type ScriptRun = {
  script: Pick<ShellStep, "run" | "network">;
  of: { stepId: string; attemptId: number; gate?: string };
  tail: OutputTail;
};

const maxOutputPartChars = 256 * 1024;

export const runScript = async (
  { deps: { sandbox, lent }, events }: StepContext,
  { script: { run, network }, of, tail }: ScriptRun,
  signal: AbortSignal,
) => {
  const limit = new OutputLimit(maxOutputPartChars);
  const masked = { stdout: new MaskedStream(lent), stderr: new MaskedStream(lent) };
  const emit = ({ stream, text }: OutputChunk) =>
    events.emit({ kind: "output", payload: { ...of, stream, text } });
  const take = ({ stream, text }: OutputChunk) => {
    if (text === "") return;
    tail.push(text);
    const now = limit.push({ stream, text });
    if (now) emit(now);
  };
  try {
    const { exitCode } = await sandbox.exec(["sh", "-c", run], {
      signal,
      network: networkHosts(network),
      isRepoCode: true,
      isOutputKept: false,
      onOutput: (text, stream) => take({ stream, text: masked[stream].push(text) }),
    });
    return exitCode;
  } finally {
    take({ stream: "stdout", text: masked.stdout.end() });
    take({ stream: "stderr", text: masked.stderr.end() });
    const { cutLength, tail: last } = limit.end();
    if (cutLength > 0) events.emit({ kind: "output_cut", payload: { ...of, length: cutLength } });
    for (const chunk of last) emit(chunk);
  }
};
