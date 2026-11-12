import { type RunEvent, textChunkOf } from "@halinka/server/client";

import { safeText } from "./safeText";

type Stream = { write: (text: string) => unknown };

export class RunPrinter {
  private isAtLineStart = true;

  constructor(
    private readonly stdout: Stream,
    private readonly stderr: Stream,
  ) {}

  line(text: string) {
    if (!this.isAtLineStart) this.write(this.stdout, "\n");
    this.write(this.stdout, `${text}\n`);
  }

  event({ kind, payload }: RunEvent) {
    if (kind === "attempt_started") {
      this.line(`Step ${payload.stepId}: attempt ${payload.attempt} started`);
    } else if (kind === "attempt_finished") {
      const detail = payload.error ?? payload.summary;
      this.line(`Step ${payload.stepId}: ${payload.status}${detail ? `: ${detail}` : ""}`);
    } else if (kind === "gate_finished") {
      const { name, exitCode } = payload;
      const failure = exitCode === undefined ? "failed" : `failed, exit code ${exitCode}`;
      this.line(`Gate ${name}: ${exitCode === 0 ? "passed" : failure}`);
    } else if (kind === "output") {
      this.write(payload.stream === "stderr" ? this.stderr : this.stdout, payload.text);
    } else if (kind === "output_cut") {
      this.line(`Halinka left out ${payload.length} characters of the output.`);
    } else if (kind === "agent_update") {
      const chunk = textChunkOf(payload.update);
      if (chunk?.sessionUpdate === "agent_message_chunk") this.write(this.stdout, chunk.text);
    }
  }

  private write(stream: Stream, text: string) {
    const safe = safeText(text);
    if (safe === "") return;
    stream.write(safe);
    this.isAtLineStart = safe.endsWith("\n");
  }
}
