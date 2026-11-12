import type {
  ControlPlane,
  SandboxObservation,
  SandboxReport,
  SandboxTarget,
} from "@halinka/protocol";
import type { DevcontainerStatus } from "@halinka/sandbox/devcontainer";
import { errorMessage } from "@halinka/utils/errors";
import type { Release } from "@halinka/utils/fileLocks";
import { backoffMs } from "@halinka/utils/retry";

const retryBackoff = { initialDelayMs: 5000, maxDelayMs: 5 * 60 * 1000 };

type Failure = { generation: number; count: number; retryAt: number };

export type SandboxHost = {
  apply: (target: SandboxTarget, signal: AbortSignal) => Promise<SandboxObservation>;
  inspectContainers: (workflowRunIds: number[]) => Promise<Map<number, DevcontainerStatus>>;
};

export type SandboxesOptions = {
  plane: Pick<ControlPlane, "reportSandbox">;
  host: SandboxHost;
  locks: { tryTake(workflowRunId: number): Promise<Release | undefined> };
  // A container apply is slow; the runs after the limit wait for a later `sync`.
  maxApplying: number;
  // The interval between sweeps, which find the containers that differ from their spec.
  sweepMs: number;
};

const isDrifted = (
  { workflowRunId, spec }: SandboxTarget,
  containers: Map<number, DevcontainerStatus>,
) => {
  if (spec === "destroyed") return true;
  const found = containers.get(workflowRunId);
  return spec === "running" ? found?.main !== "running" : found?.isActive === true;
};

export class Sandboxes {
  private readonly applying = new Map<number, Promise<void>>();
  private readonly failures = new Map<number, Failure>();
  private readonly stopping = new AbortController();
  private sweeping: Promise<void> | undefined;
  private starting = Promise.resolve();
  private sweptAt = -Infinity;
  private isSweepBehind = false;

  constructor(private readonly options: SandboxesOptions) {}

  // A sweep that found more runs than free slots continues at the next free slot.
  isSweepDue() {
    if (this.sweeping) return false;
    if (this.isSweepBehind) return this.applying.size < this.options.maxApplying;
    return Date.now() - this.sweptAt >= this.options.sweepMs;
  }

  apply(targets: SandboxTarget[]) {
    void this.queueStart(targets, this.options.maxApplying);
  }

  // A new generation whose container already matches goes in the next list without a sweep.
  sweep(targets: SandboxTarget[]) {
    this.sweptAt = Date.now();
    this.sweeping = this.applyDrifted(targets)
      .catch((error: unknown) => {
        console.error("The runner could not inspect its sandboxes", error);
      })
      .finally(() => (this.sweeping = undefined));
  }

  async idle() {
    await this.sweeping;
    await this.starting;
    await Promise.all(this.applying.values());
  }

  // A stopped apply reports nothing: the spec stays unapplied for the next start.
  async stop() {
    this.stopping.abort();
    await this.idle();
  }

  // A worktree apply checks only files and process groups, so each one goes without the limit.
  private async applyDrifted(targets: SandboxTarget[]) {
    const containerTargets = targets.filter(({ kind }) => kind === "devcontainer");
    const worktreeTargets = targets.filter(({ kind }) => kind === "worktree");
    const containers =
      containerTargets.length > 0
        ? await this.options.host.inspectContainers(
            containerTargets.map(({ workflowRunId }) => workflowRunId),
          )
        : new Map<number, DevcontainerStatus>();
    const drifted = containerTargets.filter((target) => isDrifted(target, containers));
    const left = await this.queueStart(drifted, this.options.maxApplying);
    this.isSweepBehind = left > 0;
    await this.queueStart(worktreeTargets, Infinity);
  }

  // One start at a time, so each counts the slots after the locks of the one before.
  private queueStart(targets: SandboxTarget[], limit: number) {
    const left = this.starting.then(() => this.startFree(targets, limit));
    this.starting = left.then(() => {});
    return left;
  }

  // Gives the number of runs that it did not reach. A run whose lock another holder has takes no slot.
  private async startFree(targets: SandboxTarget[], limit: number) {
    const isWaiting = (target: SandboxTarget) =>
      !this.applying.has(target.workflowRunId) && !this.waitsForRetry(target);
    let index = 0;
    for (; index < targets.length && this.applying.size < limit; index++) {
      if (this.stopping.signal.aborted) return 0;
      const target = targets[index]!;
      if (!isWaiting(target)) continue;
      const release = await this.tryTake(target.workflowRunId);
      if (release) this.start(target, release);
    }
    return targets.slice(index).filter(isWaiting).length;
  }

  // The spec stays unapplied, so the next `sync` lists it again.
  private tryTake(workflowRunId: number) {
    return this.options.locks.tryTake(workflowRunId).catch((error: unknown) => {
      console.error(`Run ${workflowRunId}: the runner could not lock its sandbox`, error);
      return undefined;
    });
  }

  private start(target: SandboxTarget, release: Release) {
    const { workflowRunId } = target;
    const done = this.applyOne(target, release)
      .catch((error: unknown) => {
        console.error(`Run ${workflowRunId}: the runner could not apply its sandbox`, error);
      })
      .finally(() => this.applying.delete(workflowRunId));
    this.applying.set(workflowRunId, done);
  }

  private async applyOne(target: SandboxTarget, release: Release) {
    const { workflowRunId, generation } = target;
    let report: SandboxReport;
    try {
      const observation = await this.options.host.apply(target, this.stopping.signal);
      report = { workflowRunId, generation, ...observation };
      this.failures.delete(workflowRunId);
    } catch (error) {
      if (this.stopping.signal.aborted) return;
      this.recordFailure(target);
      report = { workflowRunId, generation, error: errorMessage(error) };
    } finally {
      await release();
    }
    await this.options.plane.reportSandbox(report);
  }

  private waitsForRetry({ workflowRunId, generation }: SandboxTarget) {
    const failure = this.failures.get(workflowRunId);
    return failure?.generation === generation && failure.retryAt > Date.now();
  }

  private recordFailure({ workflowRunId, generation }: SandboxTarget) {
    const previous = this.failures.get(workflowRunId);
    const count = previous?.generation === generation ? previous.count + 1 : 0;
    const retryAt = Date.now() + backoffMs(count, retryBackoff);
    this.failures.set(workflowRunId, { generation, count, retryAt });
  }
}
