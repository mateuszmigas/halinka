import {
  isAttemptItemKind,
  isEndedOrExpired,
  isLeasedStatus,
  isRunResult,
  isUnleasedStatus,
  leasedRunStatuses,
  proceedDecisions,
  type StepRunStatus,
} from "@halinka/protocol";
import {
  type Inputs,
  leafSteps,
  repoConfigPath,
  resolveBranchName,
  resolveConcurrencyGroup,
  resolveInputs,
  type LeafStep,
  withImplicitOutputs,
  type Workflow,
  workflowAgents,
} from "@halinka/workflow";

import type { ConnectedRunners, WakeRunner } from "../connectedRunners";
import { type Db, pingDb } from "../db/client";
import {
  inTransaction,
  isPassingRefusal,
  type ListRunsOptions,
  type Repositories,
  type RunWithRepo,
} from "../db/repositories";
import { type DbWorkflowRun, skipsSetup } from "../db/schema";
import { deleteRunIfGone, deleteRunOfRevokedRunner } from "../deletion";
import { inRunTransaction, type RunBus } from "../runBus";
import { closeEndedRun } from "../runEnd";
import { finishedRunRefusal, pullRequestRefusal, pushRefusal } from "../runRefusals";
import { RunStream } from "../runStream";
import { disabledAgentReason, findWaitReason, settingsRefusalReason } from "../waitReason";
import { withoutNulls } from "../withoutNulls";
import type { RepoService, WorkflowRead } from "./repoService";
import {
  invalidWorkflow,
  noRepo,
  noRun,
  noStepRun,
  RunRefusal,
  ServiceError,
} from "./serviceError";

const periodDays = 30;

const dayMs = 24 * 60 * 60 * 1000;

type RunServiceOptions = {
  db: Db;
  repositories: Repositories;
  repo: RepoService;
  connectedRunners: ConnectedRunners;
  wakeRunner: WakeRunner;
  bus: RunBus;
  localRunnerId: () => number | undefined;
};

const canCancel = (run: DbWorkflowRun) =>
  isUnleasedStatus(run.status) || (isLeasedStatus(run.status) && run.cancelRequestedAt === null);

// A message to an expired run queues it again.
const messageRefusal = ({ id, status, cancelRequestedAt }: DbWorkflowRun) => {
  if (!isLeasedStatus(status) && status !== "expired") {
    return new ServiceError("CONFLICT", `Run ${id} is not running`);
  }
  if (cancelRequestedAt) return new ServiceError("CONFLICT", `Run ${id} has a cancel request`);
  return undefined;
};

const isStepOfType = (workflow: Workflow, stepId: string, stepType: LeafStep["type"]) =>
  leafSteps(workflow).some(({ id, type }) => id === stepId && type === stepType);

// `headSha`: from a signed delivery, of a branch of this repo
export type PullRequestOfRun = { number: number; headSha: string };

type NewRun = { repoId: number; workflow: string; inputs?: Inputs };

type SandboxOfOptions = { isOnLocalRunner: boolean };

// `isUntrusted`: the steps come from a commit or a delivery, and no person starts the run
export type RunStart = {
  inputs?: Inputs;
  authorId?: number;
  isUntrusted?: boolean;
  isTestRun?: boolean;
  pullRequest?: PullRequestOfRun;
  isSkippedWhenQueued?: boolean;
};

const branchConflict = (holder: number, branch: string) =>
  new RunRefusal(
    "CONFLICT",
    `The run ${holder} uses the branch ${branch}. Wait until it ends, or cancel it.`,
    { recordReason: `The run ${holder} uses the branch of this run.` },
  );

// `workflow_runs.branch` gives this name to a run with no `branch.name`.
const isGeneratedBranch = (name: string) => /^halinka\/run-\d+$/.test(name);

const sandboxRefusal = (run: DbWorkflowRun, isFinished?: (status: string) => boolean) => {
  const refusal = finishedRunRefusal(run, isFinished);
  if (refusal) return refusal;
  if (run.sandbox === null) return new ServiceError("CONFLICT", `Run ${run.id} has no workspace`);
  return undefined;
};

const containerRunRefusal = (run: DbWorkflowRun) => {
  const refusal = sandboxRefusal(run, isEndedOrExpired);
  if (refusal) return refusal;
  if (run.sandboxKind !== "devcontainer") {
    return new ServiceError(
      "CONFLICT",
      `Run ${run.id} works in a worktree, which has no container`,
    );
  }
  return undefined;
};

// Only a container starts and stops; an expired run has no lease, so its next claim restarts it.
const containerRefusal = (run: DbWorkflowRun, spec: "running" | "stopped") => {
  const refusal = containerRunRefusal(run);
  if (refusal) return refusal;
  const { id, sandbox } = run;
  if (sandbox === "destroyed") {
    return new ServiceError(
      "CONFLICT",
      `The workspace of run ${id} is removed. Reopen a step to make it again.`,
    );
  }
  if (sandbox === spec) {
    return new ServiceError("CONFLICT", `The container of run ${id} is already ${spec}`);
  }
  return undefined;
};

const isSandboxPending = (run: DbWorkflowRun) =>
  !isLeasedStatus(run.status) && run.sandboxObservedGeneration !== run.sandboxGeneration;

// A person shares the container with no agent.
const relayRefusal = (run: DbWorkflowRun) => {
  const refusal = containerRunRefusal(run);
  if (refusal) return refusal;
  const { id, sandbox, sandboxObserved } = run;
  if (sandbox !== "running" || sandboxObserved !== "running" || isSandboxPending(run)) {
    return new ServiceError("CONFLICT", `The container of run ${id} does not run. Start it first.`);
  }
  return undefined;
};

const sandboxOf = (run: DbWorkflowRun, { isOnLocalRunner }: SandboxOfOptions) => {
  if (!run.sandbox || !run.sandboxKind) return undefined;
  const isInUse = isLeasedStatus(run.status);
  const canAttach = !relayRefusal(run);
  return {
    kind: run.sandboxKind,
    spec: run.sandbox,
    observed: run.sandboxObserved ?? undefined,
    isInUse,
    isPending: isSandboxPending(run),
    // A claim that keeps the spec keeps the error of an earlier check.
    error: isInUse ? undefined : (run.sandboxError ?? undefined),
    // The attach link works only on the computer that runs the container.
    attach: (isOnLocalRunner && canAttach && run.sandboxAttach) || undefined,
    sshFolder: (!isOnLocalRunner && canAttach && run.sandboxAttach?.containerFolder) || undefined,
  };
};

// A reopen takes a finished run, or a leased run without a cancel request.
const reopenRefusal = (run: DbWorkflowRun) =>
  isRunResult(run.status) ? undefined : messageRefusal(run);

const canReopen = ({ status, attempts }: { status: StepRunStatus; attempts: number }) =>
  status !== "running" && status !== "superseded" && attempts > 0;

type TargetStepRun = { id: number; stepId: string; status: StepRunStatus };

const reopenTargets = (
  run: RunWithRepo,
  stepRuns: TargetStepRun[],
  attempts: { stepRunId: number }[],
) => {
  if (reopenRefusal(run)) return [];
  const agentSteps = new Set(
    leafSteps(run.workflow).flatMap(({ id, type }) => (type === "agent" ? [id] : [])),
  );
  const attempted = new Set(attempts.map(({ stepRunId }) => stepRunId));
  return stepRuns
    .filter(
      ({ id, stepId, status }) =>
        agentSteps.has(stepId) && canReopen({ status, attempts: attempted.has(id) ? 1 : 0 }),
    )
    .map(({ id }) => id);
};

const retryTargets = (
  run: RunWithRepo,
  stepRuns: TargetStepRun[],
  attempts: { stepRunId: number }[],
) => {
  if (reopenRefusal(run)) return [];
  const attempted = new Set(attempts.map(({ stepRunId }) => stepRunId));
  return stepRuns
    .filter(
      ({ id, stepId, status }) =>
        status === "failed" && attempted.has(id) && isStepOfType(run.workflow, stepId, "github"),
    )
    .map(({ id }) => id);
};

const messageTarget = (
  run: RunWithRepo,
  stepRuns: TargetStepRun[],
  inboxItems: { stepRunId: number; kind: string; resolvedAt: Date | null }[],
) => {
  if (messageRefusal(run)) return undefined;
  const stepRun = stepRuns.find(
    ({ stepId, status }) => status === "running" && isStepOfType(run.workflow, stepId, "agent"),
  );
  if (!stepRun) return undefined;
  const kind = inboxItems.find(
    ({ stepRunId, kind, resolvedAt }) =>
      stepRunId === stepRun.id && resolvedAt === null && isAttemptItemKind(kind),
  )?.kind;
  const decision = kind && isAttemptItemKind(kind) ? proceedDecisions[kind] : undefined;
  return { stepRunId: stepRun.id, decision };
};

type ReopenTarget = NonNullable<Awaited<ReturnType<Repositories["stepRun"]["lockById"]>>>;

// Call it in a transaction with the run locked.
const reopenStep = async (
  { workflowRun, stepRun, stepAttempt, inboxItem }: Repositories,
  run: DbWorkflowRun,
  target: ReopenTarget,
) => {
  const { id, status, leaseToken, repoId, branch } = run;
  const refusal = reopenRefusal(run);
  if (refusal) throw refusal;
  if (!canReopen(target)) {
    throw new ServiceError("CONFLICT", `Step run ${target.id} of run ${id} cannot be reopened`);
  }
  if (isRunResult(status)) {
    const holder = await workflowRun.findActiveByBranch(repoId, branch);
    if (holder) throw branchConflict(holder, branch);
  }
  const commits = await stepAttempt.findCommits(target.id);
  const reopenBefore =
    target.reopenBefore ??
    commits.before ??
    (await stepAttempt.findLastCheckpoint(id, { before: target.id })) ??
    run.baseSha;
  const reopenAfter = commits.after ?? target.reopenAfter ?? reopenBefore;
  const superseded = await stepRun.supersedeFrom(id, target.id);
  await stepAttempt.markLost(...superseded);
  await inboxItem.closePendingByStepRun(...superseded);
  const { parent } = target;
  if (parent) await stepRun.restart(id, parent.stepRunId);
  const reopened = await stepRun.start(id, target.stepId, {
    parent,
    reopen: { reopenedStepRunId: target.id, reopenBefore, reopenAfter },
  });
  // The old engine loses its lease, so each later write of it fails.
  const queued = leaseToken
    ? await workflowRun.requeue(id, leaseToken)
    : await workflowRun.reopen(id);
  if (!queued) throw new Error(`Run ${id} changed while it was locked`);
  return reopened;
};

export class RunService {
  constructor(private readonly options: RunServiceOptions) {}

  async create({ repoId, workflow, inputs }: NewRun, authorId: number | undefined) {
    const read = await this.options.repo.readWorkflow(repoId, workflow);
    return this.createFrom(repoId, read, { inputs, authorId });
  }

  async createTest(
    { repoId, workflow, source, baseHash, inputs }: NewRun & { source: string; baseHash: string },
    authorId: number | undefined,
  ) {
    const read = await this.options.repo.readDraft(repoId, { workflow, source, baseHash });
    return this.createFrom(repoId, read, { inputs, authorId, isTestRun: true });
  }

  async createFrom(
    repoId: number,
    { head, defaultBranch, path, source, config, workflow: definition, problems }: WorkflowRead,
    {
      inputs: given,
      authorId,
      isUntrusted = false,
      isTestRun = false,
      pullRequest,
      isSkippedWhenQueued = false,
    }: RunStart,
  ) {
    if (!definition) throw invalidWorkflow(path, problems);
    const resolved = resolveInputs(definition.inputs, given);
    if (!resolved.ok) {
      const issues = resolved.problems.map(({ name, message }) => ({
        path: ["inputs", name],
        message,
      }));
      const note = resolved.problems.map(({ name, message }) => `${name}: ${message}`).join("; ");
      throw new RunRefusal("BAD_REQUEST", "Check the inputs", {
        recordReason: `Check the inputs. ${note}`,
        details: {
          issues,
        },
      });
    }
    const branch = resolveBranchName(definition, resolved.value);
    if (!branch.ok) {
      throw new RunRefusal("BAD_REQUEST", branch.problems.join(" "), {
        recordReason: "The branch name is not valid.",
      });
    }
    const branchName = isTestRun ? undefined : branch.value;
    const group = resolveConcurrencyGroup(definition, resolved.value);
    if (!group.ok) {
      throw new RunRefusal("BAD_REQUEST", group.problems.join(" "), {
        recordReason: "The concurrency group is not valid.",
      });
    }
    const concurrencyGroup = isTestRun ? undefined : group.value;
    const runsOn = definition["runs-on"] ?? [];
    const agents = workflowAgents(definition);
    const devcontainer = await this.options.repo.readDevcontainer(repoId, head, config);
    if (!isTestRun && !pullRequest)
      await this.checkSecrets(repoId, devcontainer?.setupSecrets ?? []);
    const files = {
      [path]: source,
      ...(config && { [repoConfigPath]: config.source }),
      ...(devcontainer?.source !== undefined && { [devcontainer.path]: devcontainer.source }),
    };

    // read committed: after a conflict, the lookup sees the run that has the branch
    const run = await inTransaction(
      this.options.db,
      async ({ agent, repo, runner, workflowSnapshot, workflowRun }) => {
        // A share lock blocks a deletion; `update` makes runs of one branch or group commit in id order.
        const locked = await repo.lockById(
          repoId,
          branchName || concurrencyGroup ? "update" : "share",
        );
        if (!locked || locked.deletingAt) throw noRepo(repoId);
        const snapshot = await workflowSnapshot.findOrCreate({
          repoId,
          path,
          files,
          resolved: definition,
          devcontainer: devcontainer?.path,
          setupNetwork: devcontainer?.setupNetwork,
          setupRun: devcontainer?.setupRun,
          setupSecrets: devcontainer?.setupSecrets,
          setupDocker: devcontainer?.setupDocker,
          runsOn,
          agents,
        });
        const disabled = await agent.listDisabled(agents);
        if (disabled.length > 0)
          throw new ServiceError("BAD_REQUEST", disabledAgentReason(disabled));
        const refusal =
          locked.runnerId !== null &&
          (await runner.findSettingsRefusal(locked.runnerId, snapshot.id));
        if (refusal && !isPassingRefusal(refusal.refusal)) {
          throw new ServiceError(
            "BAD_REQUEST",
            settingsRefusalReason({ ...refusal, runsOn, agents }),
          );
        }
        if (locked.kind === "github" && branchName) {
          if (isGeneratedBranch(branchName)) {
            throw new RunRefusal(
              "BAD_REQUEST",
              `The name ${branchName} is for the run with that id. Use another branch name.`,
              { recordReason: "The branch name is for a run with that id." },
            );
          }
          if (branchName === defaultBranch) {
            throw new RunRefusal(
              "BAD_REQUEST",
              `The branch ${branchName} is the default branch of the repo. Use another branch name.`,
              { recordReason: "The branch name is the default branch of the repo." },
            );
          }
          const holder = await workflowRun.findByBranch(repoId, branchName);
          if (holder !== undefined) {
            throw new RunRefusal(
              "CONFLICT",
              `The run ${holder} holds the branch ${branchName}. Delete that run, or use another branch name.`,
              { recordReason: `The run ${holder} holds the branch of this run.` },
            );
          }
        }
        if (
          isSkippedWhenQueued &&
          ((await workflowRun.hasQueuedByWorkflow(repoId, path)) ||
            (concurrencyGroup &&
              (await workflowRun.listInGroup(repoId, concurrencyGroup, ["queued"])).length > 0))
        ) {
          const note =
            "A run of this workflow or its concurrency group is queued, so no run started.";
          throw new RunRefusal("CONFLICT", note, { recordReason: note });
        }
        const created = await workflowRun.create({
          repoId,
          runnerId: locked.runnerId,
          workflowSnapshotId: snapshot.id,
          authorId,
          inputs: resolved.value,
          isUntrusted,
          isTestRun,
          branchName,
          concurrencyGroup,
          baseSha: pullRequest?.headSha ?? head,
          definitionSha: head,
          ...(pullRequest && { pullRequestNumber: pullRequest.number }),
        });
        if (created) return created;
        const holder = branchName && (await workflowRun.findActiveByBranch(repoId, branchName));
        if (holder) throw branchConflict(holder, branchName);
        throw new ServiceError(
          "CONFLICT",
          "An active run uses the branch of this run. Wait until it ends, or cancel it.",
        );
      },
    );
    if (concurrencyGroup && definition.concurrency?.cancel_in_progress) {
      await this.cancelEarlierRuns(repoId, concurrencyGroup, run.id);
    }
    await this.options.wakeRunner(run.id);
    return run;
  }

  // After the commit: a leased write locks a run and then its repo, so the other order can deadlock.
  private async cancelEarlierRuns(repoId: number, group: string, newWorkflowRunId: number) {
    const runs = await this.options.repositories.workflowRun.listInGroup(repoId, group, [
      "queued",
      ...leasedRunStatuses,
      "expired",
    ]);
    for (const { id } of runs.filter((run) => run.id < newWorkflowRunId)) {
      try {
        await this.cancel(id);
      } catch (error) {
        console.error(error);
      }
    }
  }

  async list(options: ListRunsOptions) {
    const runs = await this.options.repositories.workflowRun.list({
      ...options,
      limit: options.limit + 1,
    });
    const page = runs.slice(0, options.limit).map(withoutNulls);
    return { runs: page, nextBeforeId: runs.length > options.limit ? page.at(-1)?.id : undefined };
  }

  async totals(now: Date) {
    const today = new Date(now.toISOString().slice(0, 10));
    const dayOf = (index: number) =>
      new Date(today.getTime() - (periodDays - 1 - index) * dayMs).toISOString().slice(0, 10);
    const counts = await this.options.repositories.workflowRun.countByDaySince(new Date(dayOf(0)));
    const perDay = Array.from({ length: periodDays }, (_, index) => {
      const day = dayOf(index);
      const {
        runs = 0,
        succeeded = 0,
        failed = 0,
      } = counts.find((count) => count.day === day) ?? {};
      return { day, succeeded, failed, other: runs - succeeded - failed };
    });
    const sumOf = (key: "succeeded" | "failed" | "other") =>
      perDay.reduce((sum, entry) => sum + entry[key], 0);
    return {
      days: periodDays,
      runs: sumOf("succeeded") + sumOf("failed") + sumOf("other"),
      succeeded: sumOf("succeeded"),
      failed: sumOf("failed"),
      perDay,
    };
  }

  async listCosts() {
    const totals = await this.options.repositories.stepAttempt.listCostTotals(periodDays);
    return { days: periodDays, totals: totals.map(withoutNulls) };
  }

  ping() {
    return pingDb(this.options.db);
  }

  async listEvents(id: number, afterSeq: number) {
    const { workflowRun, workflowRunEvent } = this.options.repositories;
    const [exists, events] = await Promise.all([
      workflowRun.has(id),
      workflowRunEvent.listByRun(id, afterSeq),
    ]);
    if (!exists) throw noRun(id);
    return events;
  }

  async watch(id: number, afterSeq: number) {
    const { repositories, bus } = this.options;
    if (!(await repositories.workflowRun.has(id))) throw noRun(id);
    return new RunStream(repositories.workflowRunEvent, bus, { workflowRunId: id, afterSeq });
  }

  private async checkSecrets(repoId: number, names: string[]) {
    if (names.length === 0) return;
    const stored = await this.options.repositories.repoSecret.listByRepo(repoId);
    const missing = names.filter((name) => !stored.some((row) => row.name === name));
    if (missing.length > 0) {
      throw new ServiceError(
        "BAD_REQUEST",
        `The repo has no secret ${missing.join(", ")}. An Admin can set it on the page of the repo.`,
      );
    }
  }

  async get(id: number) {
    const { db, repositories, connectedRunners, localRunnerId } = this.options;
    const [run, stepRuns, attempts, inboxItems, undeliveredMessages] = await inTransaction(
      db,
      ({ workflowRun, stepRun, stepAttempt, inboxItem, agentMessage }) =>
        Promise.all([
          workflowRun.findById(id),
          stepRun.listByRun(id),
          stepAttempt.listByRun(id),
          inboxItem.listByRun(id),
          agentMessage.listUndeliveredByRun(id),
        ]),
      { isolationLevel: "repeatable read" },
    );
    if (!run) throw noRun(id);
    return {
      ...withoutNulls(run),
      waitReason:
        run.status === "queued"
          ? await findWaitReason(repositories, connectedRunners, run)
          : undefined,
      canCancel: canCancel(run),
      canDelete: !finishedRunRefusal(run),
      isTestRun: run.testRun,
      isSetupSkipped: skipsSetup(run),
      canPush: !pushRefusal(run),
      canOpenPullRequest: !pullRequestRefusal(run),
      // of the branch, also when another run on it pushed
      ...(await this.pushedOf(run.repoId, run.branch)),
      sandbox: sandboxOf(run, { isOnLocalRunner: run.runnerId === localRunnerId() }),
      canRemoveSandbox: !sandboxRefusal(run) && run.sandbox !== "destroyed",
      canStartSandbox: !containerRefusal(run, "running"),
      canStopSandbox: !containerRefusal(run, "stopped"),
      messageTarget: messageTarget(run, stepRuns, inboxItems),
      reopenTargets: reopenTargets(run, stepRuns, attempts),
      retryTargets: retryTargets(run, stepRuns, attempts),
      stepRuns: withImplicitOutputs(run.workflow, stepRuns).map(withoutNulls),
      attempts: attempts.map(withoutNulls),
      inboxItems: inboxItems.map(withoutNulls),
      undeliveredMessages: undeliveredMessages.map(withoutNulls),
    };
  }

  async sendMessage(
    { id, stepRunId, text }: { id: number; stepRunId: number; text: string },
    author: string,
  ) {
    const message = await this.inRunTransaction(async (repositories, changed) => {
      const { workflowRun, stepRun, inboxItem, agentMessage } = repositories;
      const locked = await workflowRun.lockById(id);
      if (!locked || locked.deletingAt) throw noRun(id);
      const target = await stepRun.lockById(id, stepRunId);
      if (!target) throw noStepRun(id, stepRunId);
      if (!isStepOfType(locked.workflow, target.stepId, "agent")) {
        throw new ServiceError("BAD_REQUEST", `The step ${target.stepId} is not an agent step`);
      }
      changed(id, "state");
      if (target.status !== "running") {
        const reopen = await reopenStep(repositories, locked, target);
        return agentMessage.create({
          workflowRunId: id,
          stepRunId: reopen,
          text,
          author,
        });
      }
      const refusal = messageRefusal(locked);
      if (refusal) throw refusal;
      const pending = await inboxItem.findPendingAttemptItem(stepRunId);
      if (pending) {
        await inboxItem.resolve(pending.id, {
          decision: proceedDecisions[pending.kind],
          note: null,
          answer: null,
          resolvedBy: author,
        });
      }
      if (pending || locked.status === "expired") await workflowRun.resume(id);
      return agentMessage.create({ workflowRunId: id, stepRunId, text, author });
    });
    await this.options.wakeRunner(id);
    return message;
  }

  async retryStep(id: number, stepRunId: number) {
    const reopened = await this.inRunTransaction(async (repositories, changed) => {
      const { workflowRun, stepRun } = repositories;
      const locked = await workflowRun.lockById(id);
      if (!locked || locked.deletingAt) throw noRun(id);
      const target = await stepRun.lockById(id, stepRunId);
      if (!target) throw noStepRun(id, stepRunId);
      if (!isStepOfType(locked.workflow, target.stepId, "github")) {
        throw new ServiceError("BAD_REQUEST", `The step ${target.stepId} is not a github step`);
      }
      if (target.status !== "failed") {
        throw new ServiceError("CONFLICT", `Step run ${stepRunId} did not fail`);
      }
      changed(id, "state");
      return reopenStep(repositories, locked, target);
    });
    await this.options.wakeRunner(id);
    return { stepRunId: reopened };
  }

  // A running run may still finish with the engine's own result.
  async cancel(id: number) {
    const run = await this.inRunTransaction(async (repositories, changed) => {
      const { workflowRun } = repositories;
      const locked = await workflowRun.lockById(id);
      if (!locked) throw noRun(id);
      changed(id, "state");
      if (isLeasedStatus(locked.status)) return workflowRun.requestCancel(id);
      if (!isUnleasedStatus(locked.status)) return locked;
      const cancelled = await workflowRun.cancelUnleased(id);
      await closeEndedRun(repositories, id, "cancelled");
      return cancelled;
    });
    if (!run) throw new Error(`Run ${id} changed while it was locked`);
    if (isLeasedStatus(run.status)) {
      await this.options.wakeRunner(id);
    }
    return run;
  }

  async setSandbox(id: number, spec: "running" | "stopped") {
    const run = await this.inRunTransaction(async ({ workflowRun }, changed) => {
      const locked = await workflowRun.lockById(id);
      if (!locked) throw noRun(id);
      const refusal = containerRefusal(locked, spec);
      if (refusal) throw refusal;
      changed(id, "state");
      await workflowRun.setSandbox(id, spec);
      return locked;
    });
    await this.options.wakeRunner(id);
    return run;
  }

  async delete(id: number) {
    const isDeleted = await this.inRunTransaction(async (repositories, changed) => {
      const { workflowRun } = repositories;
      const locked = await workflowRun.lockById(id);
      if (!locked) throw noRun(id);
      const refusal = finishedRunRefusal(locked);
      if (refusal) throw refusal;
      changed(id, "state");
      await workflowRun.markDeleting(id);
      if (await deleteRunOfRevokedRunner(repositories, locked)) {
        await repositories.repo.deleteIfGone(locked.repoId);
        return true;
      }
      return deleteRunIfGone(repositories, id);
    });
    if (!isDeleted) await this.options.wakeRunner(id);
    return { id, isDeleted };
  }

  private async pushedOf(repoId: number, branch: string) {
    const pushed = await this.options.repositories.pushedBranch.find(repoId, branch);
    return { pushedCommit: pushed?.commit, pullRequestUrl: pushed?.pullRequestUrl ?? undefined };
  }

  // Keeps the container, and the next attempt commits the edits of the person.
  openRelay(id: number) {
    return inTransaction(this.options.db, async ({ workflowRun }) => {
      const run = await workflowRun.lockById(id);
      if (!run || run.runnerId === null) throw noRun(id);
      const refusal = relayRefusal(run);
      if (refusal) throw refusal;
      await workflowRun.markWorkspaceOpened(id);
      return run.runnerId;
    });
  }

  // No lock: a claim that commits after this read sends its own signal.
  async relayRefusal(id: number) {
    const run = await this.options.repositories.workflowRun.findById(id);
    return run ? relayRefusal(run) : noRun(id);
  }

  async sshHostKey(id: number) {
    const found = await this.options.repositories.workflowRun.findRunnerSshKey(id);
    if (!found) throw noRun(id);
    const { runnerId, sshHostKey } = found;
    if (!sshHostKey) throw new ServiceError("CONFLICT", `The runner of run ${id} has no SSH key`);
    return { runnerId, sshHostKey };
  }

  async removeSandbox(id: number) {
    const removal = await this.inRunTransaction(async ({ workflowRun }, changed) => {
      const locked = await workflowRun.lockById(id);
      if (!locked) throw noRun(id);
      const refusal = sandboxRefusal(locked);
      if (refusal) throw refusal;
      if (locked.sandbox === "destroyed") return { run: locked, isNew: false };
      changed(id, "state");
      await workflowRun.destroySandbox(id);
      return { run: locked, isNew: true };
    });
    if (removal.isNew) await this.options.wakeRunner(id);
    return removal.run;
  }

  private inRunTransaction<T>(use: Parameters<typeof inRunTransaction<T>>[2]) {
    return inRunTransaction(this.options.db, this.options.bus, use);
  }
}
