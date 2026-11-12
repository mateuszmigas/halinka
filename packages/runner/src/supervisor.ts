import { setTimeout as sleep } from "node:timers/promises";

import type { EngineResult, LentValues, RunInbox } from "@halinka/engine";
import {
  type ClaimedRun,
  type ControlPlane,
  hasCode,
  isTransient,
  maxRunErrorLength,
  type RunLease,
  type RunnerCapabilities,
  type RunResult,
} from "@halinka/protocol";
import { errorMessage } from "@halinka/utils/errors";
import { backoffMs } from "@halinka/utils/retry";

import type { AgentTests } from "./agentTests";
import { warnOnDockerChange } from "./capabilities";
import { RunInboxBox } from "./runInboxBox";
import type { Sandboxes } from "./sandboxes";

const refusedBackoff = { initialDelayMs: 5000, maxDelayMs: 60_000 };

// Docker can start after the runner, and a person can install an agent.
const capabilitiesSyncs = 12;

export type ExecuteClaimedRun = (
  run: ClaimedRun,
  inbox: RunInbox,
  signal: AbortSignal,
) => Promise<EngineResult>;

export type SupervisorOptions = {
  // It repeats a transient error until the stop (`runnerPlane`).
  plane: ControlPlane;
  // A run that waits for a person does not count.
  capacity: number;
  // At the start; `inspectCapabilities` gives the later ones.
  capabilities: RunnerCapabilities;
  inspectCapabilities: () => Promise<RunnerCapabilities>;
  pollMs: number;
  execute: ExecuteClaimedRun;
  // Before the engine of a claimed run starts.
  onClaim: (workflowRunId: number) => void;
  lent: Pick<LentValues, "mask">;
  // `apply` and `sweep` get only the runs without an engine in this process
  sandboxes: Pick<Sandboxes, "isSweepDue" | "apply" | "sweep">;
  agentTests: Pick<AgentTests, "isFree" | "start">;
  // The server asked for a restart into its build, and the process may restart now.
  onUpdate?: () => void;
};

type AbortCause = "cancel" | "stop";

type Outcome = { result: RunResult; error?: string };

type Entry = {
  lease: RunLease;
  controller: AbortController;
  inbox: RunInboxBox;
  done: Promise<void>;
};

export class Supervisor {
  private readonly registry = new Map<number, Entry>();
  private readonly stopping = new AbortController();
  private looping: Promise<void> | undefined;
  private inspecting: Promise<void> | undefined;
  private capabilities: RunnerCapabilities;
  private syncs = 0;
  private isWoken = false;
  private endIdle = () => {};

  constructor(private readonly options: SupervisorOptions) {
    this.capabilities = options.capabilities;
  }

  start() {
    if (this.looping) return;
    warnOnDockerChange(undefined, this.capabilities);
    this.looping = this.loop();
  }

  wake() {
    this.isWoken = true;
    this.endIdle();
  }

  held() {
    return [...this.registry.values()].map(({ lease }) => lease);
  }

  isHolding(workflowRunId: number) {
    return this.registry.has(workflowRunId);
  }

  async stop({ isGivingBack = true }: { isGivingBack?: boolean } = {}) {
    this.stopping.abort();
    for (const entry of this.registry.values()) this.abort(entry, "stop");
    this.endIdle();
    await this.looping;
    await Promise.allSettled([...this.registry.values()].map(({ done }) => done));
    await this.inspecting;
    if (!isGivingBack) return;
    await this.options.plane
      .sync({ held: [], capacity: 0, capabilities: this.capabilities })
      .catch((error: unknown) => {
        console.error("The runner could not give back its runs", error);
      });
  }

  // Register claimed runs before the next `sync`, or the server gives them back.
  private async loop() {
    const { plane, capacity, sandboxes, agentTests } = this.options;
    while (!this.stopping.signal.aborted) {
      this.isWoken = false;
      if (++this.syncs % capabilitiesSyncs === 0) this.inspectCapabilities();
      try {
        const isSweep = sandboxes.isSweepDue();
        const {
          keep,
          claimed,
          answers,
          messages,
          sandboxes: targets,
          agentTest,
          update,
        } = await plane.sync({
          held: this.held(),
          capacity: Math.max(0, capacity - this.busyRuns()),
          capabilities: this.capabilities,
          isSweep,
          canTest: agentTests.isFree(),
        });
        if (this.stopping.signal.aborted) break;
        const kept = new Set(keep);
        for (const [workflowRunId, entry] of this.registry) {
          if (!kept.has(workflowRunId)) this.abort(entry, "cancel");
        }
        for (const run of claimed) this.startEngine(run);
        // Answers first: the engine gives an answer that arrives with a message to the agent too.
        for (const answer of answers) {
          this.registry.get(answer.workflowRunId)?.inbox.deliverAnswer(answer);
        }
        for (const message of messages) {
          this.registry.get(message.workflowRunId)?.inbox.deliverMessage(message);
        }
        const unheld = targets.filter(({ workflowRunId }) => !this.registry.has(workflowRunId));
        if (isSweep) sandboxes.sweep(unheld);
        else sandboxes.apply(unheld);
        if (agentTest) agentTests.start(agentTest);
        const isIdle = this.registry.size === 0 && agentTests.isFree();
        if (update === "now" || (update === "when_idle" && isIdle)) {
          this.options.onUpdate?.();
        }
      } catch (error) {
        // A stop closes the connection of a sync in flight.
        if (this.stopping.signal.aborted) break;
        console.error("The runner could not sync with the server", error);
      }
      await this.idle();
    }
  }

  private inspectCapabilities() {
    this.inspecting ??= this.options
      .inspectCapabilities()
      .then((capabilities) => {
        warnOnDockerChange(this.capabilities, capabilities);
        this.capabilities = capabilities;
      })
      .finally(() => (this.inspecting = undefined));
  }

  private idle() {
    return new Promise<void>((resolve) => {
      if (this.isWoken || this.stopping.signal.aborted) return resolve();
      const timer = setTimeout(() => this.endIdle(), this.options.pollMs);
      this.endIdle = () => {
        clearTimeout(timer);
        this.endIdle = () => {};
        resolve();
      };
    });
  }

  private startEngine(run: ClaimedRun) {
    const { workflowRunId } = run.lease;
    if (this.registry.has(workflowRunId)) {
      console.error(`Run ${workflowRunId} already has an engine in this process`);
      return;
    }
    this.options.onClaim(workflowRunId);
    const controller = new AbortController();
    const inbox = new RunInboxBox(() => this.wake());
    const done = (async () => {
      const outcome = await this.runEngine(run, inbox, controller.signal);
      if (outcome) await this.finish(run.lease, outcome);
      this.registry.delete(workflowRunId);
      // A reopen gives the run back while its engine ends: claim it again at once.
      this.wake();
    })();
    this.registry.set(workflowRunId, { lease: run.lease, controller, inbox, done });
  }

  private busyRuns() {
    return [...this.registry.values()].filter(({ inbox }) => !inbox.isWaiting()).length;
  }

  private abort(entry: Entry, cause: AbortCause) {
    entry.controller.abort(cause);
  }

  private async runEngine(
    run: ClaimedRun,
    inbox: RunInbox,
    signal: AbortSignal,
  ): Promise<Outcome | undefined> {
    const cause = () => (signal.aborted ? (signal.reason as AbortCause) : undefined);
    try {
      const result = await this.options.execute(run, inbox, signal);
      if (result !== "aborted") return { result };
      return cause() === "cancel" ? { result: "cancelled" } : undefined;
    } catch (error) {
      if (cause() === "stop" || hasCode(error, "lease_lost")) return undefined;
      if (cause() === "cancel") return { result: "cancelled" };
      const text = this.options.lent.mask(errorMessage(error));
      console.error(`Run ${run.lease.workflowRunId} stopped: ${text}`);
      return { result: "failed", error: errorMessage(error) };
    }
  }

  private sentError(error: string | undefined) {
    return error && this.options.lent.mask(error).slice(0, maxRunErrorLength);
  }

  // A refused result goes again as failed; a refused failure goes again later, so the run stays held.
  private async finish(lease: RunLease, outcome: Outcome) {
    let { result } = outcome;
    let error = this.sentError(outcome.error);
    for (let refusals = 0; ;) {
      try {
        await this.options.plane.finishRun(lease, result, error);
        return;
      } catch (caught) {
        if (hasCode(caught, "lease_lost") || isTransient(caught)) return;
        if (result !== "failed") {
          if (!hasCode(caught, "result_refused")) error = this.sentError(errorMessage(caught));
          result = "failed";
          continue;
        }
        console.error(`Run ${lease.workflowRunId}: the server refused the result`, caught);
        await sleep(backoffMs(refusals++, refusedBackoff), undefined, {
          signal: this.stopping.signal,
        }).catch(() => {});
        if (this.stopping.signal.aborted) return;
      }
    }
  }
}
