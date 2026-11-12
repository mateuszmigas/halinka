import { isEndedOrExpired } from "@halinka/protocol";
import {
  type ApiClient,
  type ApiOutputs,
  isDefinedError,
  isUnauthorized,
  type StoredRunEvent,
  watchRun,
} from "@halinka/server/client";
import { errorMessage } from "@halinka/utils/errors";

import type { RunPrinter } from "./runPrinter";

type RunDetail = ApiOutputs["runs"]["get"];

type RunFollowerOptions = {
  api: Pick<ApiClient, "runs">;
  workflowRunId: number;
  runUrl: string;
  printer: RunPrinter;
  pollMs?: number;
  readTimeoutMs: number;
};

export class RunFollower {
  private after = 0;
  private last: RunDetail | undefined;
  private isAnswering = true;
  private isReadQueued = false;
  private reads = Promise.resolve();
  private readonly stopping = new AbortController();
  private readonly ended = Promise.withResolvers<RunDetail | undefined>();

  constructor(private readonly options: RunFollowerOptions) {}

  async follow(signal: AbortSignal) {
    const { api, workflowRunId, pollMs } = this.options;
    signal.addEventListener("abort", () => this.ended.resolve(undefined), { once: true });
    const watch = watchRun({
      watch: (input, options) => api.runs.watch(input, options),
      workflowRunId,
      signal: this.stopping.signal,
      pollMs,
      onEvents: (events) => this.print(events),
      onState: () => this.refresh(),
    }).then((error) => {
      if (error) this.ended.reject(error);
    });
    this.refresh();
    const run = await this.ended.promise.finally(() => this.stopping.abort());
    await watch;
    if (run) await this.printLastEvents(signal);
    return run;
  }

  // One read runs at a time, and at most one waits for it.
  private refresh() {
    if (this.isReadQueued) return;
    this.isReadQueued = true;
    this.reads = this.reads.then(() => {
      this.isReadQueued = false;
      return this.read();
    });
  }

  private async read() {
    if (this.stopping.signal.aborted) return;
    const { api, workflowRunId, printer, readTimeoutMs } = this.options;
    try {
      const signal = AbortSignal.any([this.stopping.signal, AbortSignal.timeout(readTimeoutMs)]);
      const run = await api.runs.get({ id: workflowRunId }, { signal });
      this.isAnswering = true;
      this.report(run);
      if (isEndedOrExpired(run.status)) this.ended.resolve(run);
    } catch (error) {
      if (isDefinedError(error) || isUnauthorized(error)) {
        this.ended.reject(error);
      } else if (!this.stopping.signal.aborted && this.isAnswering) {
        this.isAnswering = false;
        printer.line(`The server did not answer: ${errorMessage(error)}. Halinka tries again.`);
      }
    }
  }

  private report(run: RunDetail) {
    const { printer, runUrl } = this.options;
    if (run.waitReason && run.waitReason !== this.last?.waitReason) {
      printer.line(`Waiting: ${run.waitReason}`);
    }
    if (run.status === "waiting_input" && this.last?.status !== run.status) {
      printer.line(`The run waits for a person: ${runUrl}`);
    }
    this.last = run;
  }

  private print(events: StoredRunEvent[]) {
    for (const { seq, event } of events) {
      this.after = seq;
      this.options.printer.event(event);
    }
  }

  // The status can change before the stream gives the last events.
  private async printLastEvents(stopping: AbortSignal) {
    const { api, workflowRunId, printer, readTimeoutMs } = this.options;
    try {
      const signal = AbortSignal.any([stopping, AbortSignal.timeout(readTimeoutMs)]);
      this.print(await api.runs.events({ id: workflowRunId, after: this.after }, { signal }));
    } catch (error) {
      printer.line(`Halinka did not read the last output: ${errorMessage(error)}.`);
    }
  }
}
