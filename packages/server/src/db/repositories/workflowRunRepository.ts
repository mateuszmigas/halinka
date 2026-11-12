import { randomUUID } from "node:crypto";

import {
  endedOrExpiredStatuses,
  leasedRunStatuses,
  type RunResult,
  type SandboxKind,
  type SandboxReport,
  type SandboxSpec,
  unleasedRunStatuses,
} from "@halinka/protocol";
import type { Inputs, Workflow } from "@halinka/workflow";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  not,
  notExists,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import type { Db } from "../client";
import {
  agentMessages,
  type DbRepo,
  type DbWorkflowRun,
  type DbWorkflowRunStatus,
  inboxItems,
  isActiveRun,
  isSandboxBehind,
  isSandboxKept,
  repoPlaceOf,
  repos,
  runners,
  workflowRuns,
  workflowSnapshots,
} from "../schema";
import {
  canTake,
  isFirstOfGroup,
  canTakeAny,
  disabledAgents,
  capabilityRefusal,
  hasWorkspace,
  isSandboxRemoved,
  settingsRefusal,
} from "./dispatchRule";
import { type RunLabel, runLabel } from "./runLabel";
import { hasAuthority } from "./runnerAuthority";

export type ListRunsOptions = {
  repoId?: number;
  state?: "active" | "ended";
  beforeId?: number;
  limit: number;
};

const leased = inArray(workflowRuns.status, [...leasedRunStatuses]);

const notDeleting = isNull(workflowRuns.deletingAt);

const active = isActiveRun(workflowRuns.status);

// No expiry check: the caller holds the run's lock.
const heldUnder = (id: number, leaseToken: string) =>
  and(eq(workflowRuns.id, id), leased, eq(workflowRuns.leaseToken, leaseToken));

const leaseEnd = (seconds: number) => sql`now() + make_interval(secs => ${seconds})`;

// An error belongs to the spec that the runner failed to apply.
const sandboxSpecOf = (spec: SandboxSpec) => {
  const changes = sql`${workflowRuns.sandbox} is distinct from ${spec}::sandbox_spec`;
  return {
    sandbox: spec,
    sandboxGeneration: sql`case when ${changes} then ${workflowRuns.sandboxGeneration} + 1 else ${workflowRuns.sandboxGeneration} end`,
    sandboxError: sql`case when ${changes} then null else ${workflowRuns.sandboxError} end`,
  };
};

const expired = lte(workflowRuns.leaseUntil, sql`now()`);

const anotherRunHasBranch = sql`exists (select 1 from workflow_runs other where other.repo_id = ${workflowRuns.repoId} and other.branch = ${workflowRuns.branch} and other.id <> ${workflowRuns.id} and other.deleting_at is null)`;

const endedOrExpired = inArray(workflowRuns.status, [...endedOrExpiredStatuses]);

const live = gt(workflowRuns.leaseUntil, sql`now()`);

const forRunner = (runnerId: number) =>
  or(eq(workflowRuns.runnerId, runnerId), isNull(workflowRuns.runnerId));

const withRepo = {
  ...getTableColumns(workflowRuns),
  ...runLabel,
  workflow: workflowSnapshots.resolved,
  setupSecrets: workflowSnapshots.setupSecrets,
  repoKind: repos.kind,
  repoPath: repos.path,
  githubRepoId: repos.githubRepoId,
};

export type RunWithRepo = DbWorkflowRun &
  RunLabel & {
    workflow: Workflow;
    setupSecrets: string[];
    repoKind: DbRepo["kind"];
    repoPath: string | null;
    githubRepoId: number | null;
  };

type ClaimOptions = {
  runnerId: number;
  holder: string;
  sandboxKind: SandboxKind;
  leaseSeconds: number;
};

type HoldLeaseOptions = {
  runnerId: number;
  publicKey: string;
  // Take `no key update` when the transaction updates the run row.
  strength?: "share" | "no key update";
};

type FinishRunOptions = { status: RunResult; error?: string };

type ListSandboxesOptions = { isSweep: boolean };

export class WorkflowRunRepository {
  constructor(private readonly db: Db) {}

  // undefined when an active run has the branch
  async create(run: {
    repoId: number;
    runnerId: number | null;
    workflowSnapshotId: number;
    authorId?: number;
    inputs: Inputs;
    isUntrusted?: boolean;
    isTestRun?: boolean;
    branchName?: string;
    concurrencyGroup?: string;
    baseSha: string;
    definitionSha: string;
    pullRequestNumber?: number;
  }): Promise<DbWorkflowRun | undefined> {
    const { isUntrusted, isTestRun, ...values } = run;
    const [created] = await this.db
      .insert(workflowRuns)
      .values({ ...values, untrusted: isUntrusted, testRun: isTestRun })
      .onConflictDoNothing({ target: [workflowRuns.repoId, workflowRuns.branch], where: active })
      .returning();
    return created;
  }

  async findActiveByBranch(repoId: number, branch: string) {
    const [run] = await this.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.repoId, repoId), eq(workflowRuns.branch, branch), active));
    return run?.id;
  }

  async findByBranch(repoId: number, branch: string) {
    const [run] = await this.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.repoId, repoId), eq(workflowRuns.branch, branch)))
      .limit(1);
    return run?.id;
  }

  async markBranchCreated(id: number) {
    await this.db.update(workflowRuns).set({ createdBranch: true }).where(eq(workflowRuns.id, id));
  }

  list(options: ListRunsOptions): Promise<(DbWorkflowRun & RunLabel)[]> {
    const { repoId, state, beforeId, limit } = options;
    return this.db
      .select({ ...getTableColumns(workflowRuns), ...runLabel })
      .from(workflowRuns)
      .innerJoin(workflowSnapshots, eq(workflowSnapshots.id, workflowRuns.workflowSnapshotId))
      .innerJoin(repos, eq(repos.id, workflowRuns.repoId))
      .where(
        and(
          notDeleting,
          repoId === undefined ? undefined : eq(workflowRuns.repoId, repoId),
          state && { active, ended: not(active) }[state],
          beforeId === undefined ? undefined : lt(workflowRuns.id, beforeId),
        ),
      )
      .orderBy(desc(workflowRuns.id))
      .limit(limit);
  }

  countByDaySince(since: Date) {
    const day = sql<string>`to_char(${workflowRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
    const countOf = (status: DbWorkflowRunStatus) =>
      sql<number>`count(*) filter (where ${workflowRuns.status} = ${status})`.mapWith(Number);
    return this.db
      .select({
        day,
        runs: sql<number>`count(*)`.mapWith(Number),
        succeeded: countOf("succeeded"),
        failed: countOf("failed"),
      })
      .from(workflowRuns)
      .where(and(notDeleting, gte(workflowRuns.createdAt, since)))
      .groupBy(day);
  }

  // Narrow: a wake after each change of a run reads only this column.
  async findRunnerId(id: number) {
    const [run] = await this.db
      .select({ runnerId: workflowRuns.runnerId })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, id));
    return run?.runnerId ?? undefined;
  }

  async findRunnerSshKey(id: number) {
    const [found] = await this.db
      .select({ runnerId: runners.id, sshHostKey: runners.sshHostKey })
      .from(workflowRuns)
      .innerJoin(runners, eq(runners.id, workflowRuns.runnerId))
      .where(eq(workflowRuns.id, id));
    return found;
  }

  // Narrow: a client polls the events, and `findById` also reads the workflow.
  async has(id: number) {
    const [run] = await this.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.id, id), notDeleting));
    return run !== undefined;
  }

  async findById(id: number): Promise<RunWithRepo | undefined> {
    const [run] = await this.selectWithRepo().where(and(eq(workflowRuns.id, id), notDeleting));
    return run;
  }

  // Call it in a transaction: the run stays locked until the transaction ends; its repo does not.
  async lockById(id: number): Promise<RunWithRepo | undefined> {
    const [run] = await this.selectWithRepo()
      .where(eq(workflowRuns.id, id))
      .for("update", { of: workflowRuns });
    return run;
  }

  // `runnerId`: the holder of the lease
  async findCredentialFacts(id: number, runnerId: number) {
    const [found] = await this.db
      .select({
        sandboxKind: workflowRuns.sandboxKind,
        agents: workflowSnapshots.agents,
        allowedAgents: runners.allowedAgents,
        repoId: workflowRuns.repoId,
        branch: workflowRuns.branch,
        authorId: workflowRuns.authorId,
        setupSecrets: workflowSnapshots.setupSecrets,
        testRun: workflowRuns.testRun,
        pullRequestNumber: workflowRuns.pullRequestNumber,
        repoKind: repos.kind,
        githubRepoId: repos.githubRepoId,
      })
      .from(workflowRuns)
      .innerJoin(workflowSnapshots, eq(workflowSnapshots.id, workflowRuns.workflowSnapshotId))
      .innerJoin(repos, eq(repos.id, workflowRuns.repoId))
      .innerJoin(runners, eq(runners.id, runnerId))
      .where(eq(workflowRuns.id, id));
    return found;
  }

  async findWaitFacts(id: number) {
    const [found] = await this.db
      .select({
        settingsRefusal,
        capabilityRefusal,
        disabledAgents,
        runnerId: runners.id,
        name: runners.name,
        labels: runners.labels,
        allowedAgents: runners.allowedAgents,
        agentsOnPath: runners.agentsOnPath,
        runnerSandboxKind: runners.sandboxKind,
        runSandboxKind: workflowRuns.sandboxKind,
        runsOn: workflowSnapshots.runsOn,
        agents: workflowSnapshots.agents,
      })
      .from(workflowRuns)
      .innerJoin(workflowSnapshots, eq(workflowSnapshots.id, workflowRuns.workflowSnapshotId))
      .innerJoin(runners, eq(runners.id, workflowRuns.runnerId))
      .where(eq(workflowRuns.id, id));
    return found;
  }

  async findWaitFactsWithNoRunner(id: number, connectedRunnerIds: number[]) {
    const [found] = await this.db
      .select({
        canBeTaken: sql<boolean>`${canTakeAny(connectedRunnerIds)}`,
        disabledAgents,
        runsOn: workflowSnapshots.runsOn,
        agents: workflowSnapshots.agents,
        untrusted: workflowRuns.untrusted,
        testRun: workflowRuns.testRun,
      })
      .from(workflowRuns)
      .innerJoin(workflowSnapshots, eq(workflowSnapshots.id, workflowRuns.workflowSnapshotId))
      .where(eq(workflowRuns.id, id));
    return found;
  }

  // What the runner holds stays on its machine.
  async deleteDeletingByRunner(runnerId: number) {
    await this.db
      .delete(workflowRuns)
      .where(and(eq(workflowRuns.runnerId, runnerId), isNotNull(workflowRuns.deletingAt)));
  }

  async hasQueuedByWorkflow(repoId: number, path: string) {
    const [run] = await this.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .innerJoin(workflowSnapshots, eq(workflowRuns.workflowSnapshotId, workflowSnapshots.id))
      .where(
        and(
          eq(workflowRuns.repoId, repoId),
          eq(workflowRuns.status, "queued"),
          eq(workflowSnapshots.path, path),
        ),
      )
      .limit(1);
    return run !== undefined;
  }

  // Call it in a transaction: the runs stay locked until the transaction ends. A held row fails it (NOWAIT).
  lockByRepo(repoId: number) {
    return this.db
      .select({ id: workflowRuns.id, runnerId: workflowRuns.runnerId, status: workflowRuns.status })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.repoId, repoId), notDeleting))
      .orderBy(asc(workflowRuns.id))
      .for("update", { noWait: true });
  }

  listQueuedIds() {
    return this.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(eq(workflowRuns.status, "queued"));
  }

  listQueuedIdsByRunner(runnerId: number) {
    return this.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(and(forRunner(runnerId), eq(workflowRuns.status, "queued")));
  }

  async markDeleting(id: number) {
    await this.db
      .update(workflowRuns)
      .set({ deletingAt: sql`now()` })
      .where(eq(workflowRuns.id, id));
    await this.db
      .update(workflowRuns)
      .set(sandboxSpecOf("destroyed"))
      .where(and(eq(workflowRuns.id, id), isNotNull(workflowRuns.sandbox)));
    // The run branch goes at an apply, also when the sandbox is gone.
    await this.db
      .update(workflowRuns)
      .set({ sandboxGeneration: sql`${workflowRuns.sandboxGeneration} + 1` })
      .where(and(eq(workflowRuns.id, id), workflowRuns.createdBranch, isSandboxRemoved));
  }

  async deleteDeleting(id: number) {
    await this.db
      .delete(workflowRuns)
      .where(and(eq(workflowRuns.id, id), isNotNull(workflowRuns.deletingAt)));
  }

  async deleteIfGone(id: number) {
    const [run] = await this.db
      .delete(workflowRuns)
      .where(and(eq(workflowRuns.id, id), isNotNull(workflowRuns.deletingAt), not(hasWorkspace)))
      .returning({ id: workflowRuns.id, repoId: workflowRuns.repoId });
    return run;
  }

  // Call it in a transaction: the row stays locked for `claim` until the transaction ends.
  async lockNextQueued(runnerId: number, sandboxKind: SandboxKind, skip: number[] = []) {
    const passed = [...skip];
    for (;;) {
      const run = await this.lockNextCandidate(runnerId, sandboxKind, passed);
      if (!run || run.concurrencyGroup === null) return run;
      if (await this.holdsGroup(run.id, run.repoId, run.concurrencyGroup)) return run;
      passed.push(run.id);
    }
  }

  private async lockNextCandidate(runnerId: number, sandboxKind: SandboxKind, skip: number[]) {
    const [run] = await this.db
      .select({
        id: workflowRuns.id,
        repoId: workflowRuns.repoId,
        concurrencyGroup: workflowRuns.concurrencyGroup,
        setupNetwork: workflowSnapshots.setupNetwork,
        setupRun: workflowSnapshots.setupRun,
        workflow: workflowSnapshots.resolved,
        inputs: workflowRuns.inputs,
        workspaceOpened: workflowRuns.workspaceOpened,
      })
      .from(workflowRuns)
      .innerJoin(workflowSnapshots, eq(workflowSnapshots.id, workflowRuns.workflowSnapshotId))
      .where(
        and(
          eq(workflowRuns.status, "queued"),
          notDeleting,
          forRunner(runnerId),
          notInArray(workflowRuns.id, skip),
          canTake(runnerId),
          isFirstOfGroup,
          // A second process with a copy of the key can overwrite the kind on the runner row.
          sandboxKind === "worktree"
            ? and(eq(workflowRuns.untrusted, false), eq(workflowRuns.testRun, false))
            : undefined,
        ),
      )
      .orderBy(asc(workflowRuns.id))
      .limit(1)
      .for("update", { of: workflowRuns, skipLocked: true });
    return run;
  }

  // Not a blocking lock: `sync` claims runs of several groups in one transaction.
  private async holdsGroup(id: number, repoId: number, group: string) {
    const key = `${repoId}:${group}`;
    const [{ locked } = { locked: false }] = await this.db
      .select({ locked: sql<boolean>`pg_try_advisory_xact_lock(hashtextextended(${key}, 0))` })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, id));
    if (!locked) return false;
    // The check is a new statement, so it sees the commits of the claim before it.
    const [first] = await this.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.id, id), isFirstOfGroup));
    return first !== undefined;
  }

  // A run keeps the sandbox kind of its workspace until the workspace is removed.
  async claim(id: number, { runnerId, holder, sandboxKind, leaseSeconds }: ClaimOptions) {
    const pendingItem = this.db
      .select({ id: inboxItems.id })
      .from(inboxItems)
      .where(and(eq(inboxItems.workflowRunId, workflowRuns.id), isNull(inboxItems.resolvedAt)));
    const leaseToken = randomUUID();
    const [run] = await this.db
      .update(workflowRuns)
      .set({
        status: sql`case when exists (${pendingItem}) then 'waiting_input'::workflow_run_status else 'running'::workflow_run_status end`,
        leaseToken,
        leaseUntil: leaseEnd(leaseSeconds),
        leaseHolder: holder,
        runnerId: sql`coalesce(${workflowRuns.runnerId}, ${runnerId}::integer)`,
        startedAt: sql`coalesce(${workflowRuns.startedAt}, now())`,
        sandboxKind: sql`case when ${hasWorkspace} then ${workflowRuns.sandboxKind} else ${sandboxKind}::sandbox_kind end`,
        ...sandboxSpecOf("running"),
      })
      .from(workflowSnapshots)
      .innerJoin(repos, eq(repos.id, workflowSnapshots.repoId))
      .where(
        and(
          eq(workflowRuns.id, id),
          eq(workflowRuns.status, "queued"),
          eq(workflowSnapshots.id, workflowRuns.workflowSnapshotId),
        ),
      )
      .returning({
        id: workflowRuns.id,
        repoKind: repos.kind,
        repoPath: repos.path,
        githubRepoId: repos.githubRepoId,
        branch: workflowRuns.branch,
        baseSha: workflowRuns.baseSha,
        definitionSha: workflowRuns.definitionSha,
        devcontainer: workflowSnapshots.devcontainer,
        setupNetwork: workflowSnapshots.setupNetwork,
        setupRun: workflowSnapshots.setupRun,
        setupSecrets: workflowSnapshots.setupSecrets,
        setupDocker: workflowSnapshots.setupDocker,
        sandboxKind: sql<SandboxKind>`${workflowRuns.sandboxKind}`,
        workflow: workflowSnapshots.resolved,
        inputs: workflowRuns.inputs,
        untrusted: workflowRuns.untrusted,
        testRun: workflowRuns.testRun,
        pullRequestNumber: workflowRuns.pullRequestNumber,
      });
    if (!run) return undefined;
    const { devcontainer, ...claimed } = run;
    return { ...claimed, ...(devcontainer !== null && { devcontainer }), leaseToken };
  }

  // Call it in a transaction: the run keeps its lease until the transaction ends.
  async holdLease(
    id: number,
    leaseToken: string,
    { runnerId, publicKey, strength = "share" }: HoldLeaseOptions,
  ) {
    const [run] = await this.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(
        and(
          heldUnder(id, leaseToken),
          live,
          eq(workflowRuns.runnerId, runnerId),
          hasAuthority(runnerId, publicKey),
        ),
      )
      .for(strength);
    return run;
  }

  async renewLeases(ids: number[], leaseSeconds: number) {
    if (!ids.length) return;
    await this.db
      .update(workflowRuns)
      .set({ leaseUntil: leaseEnd(leaseSeconds) })
      .where(inArray(workflowRuns.id, ids));
  }

  // At server start: the runners that were connected before keep their runs for one lease.
  async extendLeases(leaseSeconds: number) {
    await this.db
      .update(workflowRuns)
      .set({ leaseUntil: leaseEnd(leaseSeconds) })
      .where(leased);
  }

  async listInGroup(repoId: number, group: string, statuses: DbWorkflowRunStatus[]) {
    return this.db
      .select({ id: workflowRuns.id, status: workflowRuns.status })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.repoId, repoId),
          eq(workflowRuns.concurrencyGroup, group),
          inArray(workflowRuns.status, statuses),
        ),
      )
      .orderBy(asc(workflowRuns.id));
  }

  async requestCancel(id: number): Promise<DbWorkflowRun | undefined> {
    const [run] = await this.db
      .update(workflowRuns)
      .set({ cancelRequestedAt: sql`coalesce(${workflowRuns.cancelRequestedAt}, now())` })
      .where(and(eq(workflowRuns.id, id), leased))
      .returning();
    return run;
  }

  async waitForInput(id: number) {
    await this.db
      .update(workflowRuns)
      .set({ status: "waiting_input" })
      .where(and(eq(workflowRuns.id, id), eq(workflowRuns.status, "running")));
  }

  // An expired run has no lease, so it goes back to the queue.
  async resume(id: number) {
    await this.db
      .update(workflowRuns)
      .set({
        status: sql`case when ${workflowRuns.status} = 'expired' then 'queued'::workflow_run_status else 'running'::workflow_run_status end`,
      })
      .where(
        and(eq(workflowRuns.id, id), inArray(workflowRuns.status, ["waiting_input", "expired"])),
      );
  }

  // Call it in a transaction: the runs stay locked until the transaction ends.
  async lockWaitingLongerThan(hours: number) {
    const runs = await this.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(this.waitsLongerThan(hours))
      .orderBy(asc(workflowRuns.id))
      .for("update");
    return runs.map(({ id }) => id);
  }

  // Call it after `lockWaitingLongerThan`: a new statement sees the writes that the lock waited for.
  async expire(id: number, hours: number) {
    const [run] = await this.db
      .update(workflowRuns)
      .set({ status: "expired", leaseToken: null })
      .where(and(eq(workflowRuns.id, id), this.waitsLongerThan(hours)))
      .returning({ id: workflowRuns.id });
    return run;
  }

  async cancelUnleased(id: number): Promise<DbWorkflowRun | undefined> {
    const [run] = await this.db
      .update(workflowRuns)
      .set({ status: "cancelled", cancelRequestedAt: sql`now()`, finishedAt: sql`now()` })
      .where(and(eq(workflowRuns.id, id), inArray(workflowRuns.status, [...unleasedRunStatuses])))
      .returning();
    return run;
  }

  async requeue(id: number, leaseToken: string) {
    const [run] = await this.db
      .update(workflowRuns)
      .set({ status: "queued", leaseToken: null })
      .where(heldUnder(id, leaseToken))
      .returning({ id: workflowRuns.id });
    return run;
  }

  async reopen(id: number) {
    const [run] = await this.db
      .update(workflowRuns)
      .set({
        status: "queued",
        leaseToken: null,
        cancelRequestedAt: null,
        finishedAt: null,
        error: null,
      })
      .where(and(eq(workflowRuns.id, id), endedOrExpired))
      .returning({ id: workflowRuns.id });
    return run;
  }

  async finish(id: number, leaseToken: string, { status, error }: FinishRunOptions) {
    const [run] = await this.db
      .update(workflowRuns)
      .set({ status, leaseToken: null, finishedAt: sql`now()`, error: error ?? null })
      .where(heldUnder(id, leaseToken))
      .returning({ id: workflowRuns.id });
    return run;
  }

  async stopSandbox(id: number) {
    await this.db
      .update(workflowRuns)
      .set({ ...sandboxSpecOf("stopped"), sandboxKeptAt: sql`now()` })
      .where(and(eq(workflowRuns.id, id), eq(workflowRuns.sandbox, "running")));
  }

  async setSandbox(id: number, spec: "running" | "stopped") {
    await this.db
      .update(workflowRuns)
      .set({
        ...sandboxSpecOf(spec),
        ...(spec === "running" && { sandboxKeptAt: sql`now()`, workspaceOpened: true }),
      })
      .where(eq(workflowRuns.id, id));
  }

  async markWorkspaceOpened(id: number) {
    await this.db
      .update(workflowRuns)
      .set({ sandboxKeptAt: sql`now()`, workspaceOpened: true })
      .where(eq(workflowRuns.id, id));
  }

  // Call it with the write of a checkpoint: its `before` holds the changes of the person.
  async clearWorkspaceOpened(id: number) {
    await this.db
      .update(workflowRuns)
      .set({ workspaceOpened: false })
      .where(and(eq(workflowRuns.id, id), eq(workflowRuns.workspaceOpened, true)));
  }

  async destroySandbox(id: number) {
    await this.db
      .update(workflowRuns)
      .set(sandboxSpecOf("destroyed"))
      .where(eq(workflowRuns.id, id));
  }

  async destroySandboxesKeptBefore(hoursAgo: number) {
    const runs = await this.db
      .update(workflowRuns)
      .set(sandboxSpecOf("destroyed"))
      .where(
        and(
          isSandboxKept(workflowRuns.sandbox),
          endedOrExpired,
          lte(workflowRuns.sandboxKeptAt, sql`now() - make_interval(hours => ${hoursAgo})`),
        ),
      )
      .returning({ id: workflowRuns.id });
    return runs.map(({ id }) => id);
  }

  // `all` leaves out a removed sandbox: nothing is left to check.
  async listSandboxes(runnerId: number, { isSweep }: ListSandboxesOptions) {
    const targets = await this.db
      .select({
        workflowRunId: workflowRuns.id,
        kind: sql<SandboxKind>`${workflowRuns.sandboxKind}`,
        repoKind: repos.kind,
        repoPath: repos.path,
        githubRepoId: repos.githubRepoId,
        baseSha: workflowRuns.baseSha,
        definitionSha: workflowRuns.definitionSha,
        devcontainer: workflowSnapshots.devcontainer,
        setupNetwork: workflowSnapshots.setupNetwork,
        setupDocker: workflowSnapshots.setupDocker,
        spec: sql<SandboxSpec>`${workflowRuns.sandbox}`,
        generation: workflowRuns.sandboxGeneration,
        branchToDelete: sql<
          string | null
        >`case when ${workflowRuns.deletingAt} is not null and ${workflowRuns.createdBranch} and not ${anotherRunHasBranch} then ${workflowRuns.branch} end`,
      })
      .from(workflowRuns)
      .innerJoin(repos, eq(repos.id, workflowRuns.repoId))
      .innerJoin(workflowSnapshots, eq(workflowSnapshots.id, workflowRuns.workflowSnapshotId))
      .where(
        and(
          eq(workflowRuns.runnerId, runnerId),
          isSweep ? and(not(leased), hasWorkspace) : isSandboxBehind(workflowRuns),
        ),
      )
      .orderBy(asc(workflowRuns.id));
    return targets.map(
      ({
        repoKind,
        repoPath,
        githubRepoId,
        devcontainer,
        setupNetwork,
        setupDocker,
        ...target
      }) => ({
        ...target,
        ...repoPlaceOf({ repoKind, repoPath, githubRepoId }),
        ...(devcontainer !== null && { devcontainer, setupNetwork }),
        ...(devcontainer !== null && setupDocker && { setupDocker }),
      }),
    );
  }

  // undefined for a report that changes nothing
  async recordSandbox(runnerId: number, report: SandboxReport) {
    const { workflowRunId, generation } = report;
    const attach = "error" in report ? null : (report.attach ?? null);
    const recorded =
      "error" in report
        ? { sandboxObservedGeneration: null, sandboxError: report.error }
        : {
            sandboxObserved: report.observed,
            sandboxObservedGeneration: generation,
            sandboxAttach: attach,
            sandboxError: null,
          };
    const [run] = await this.db
      .update(workflowRuns)
      .set(recorded)
      .where(
        and(
          eq(workflowRuns.id, workflowRunId),
          eq(workflowRuns.sandboxGeneration, generation),
          not(leased),
          eq(workflowRuns.runnerId, runnerId),
          "error" in report
            ? sql`(${workflowRuns.sandboxObservedGeneration}, ${workflowRuns.sandboxError}) is distinct from (null::integer, ${report.error}::text)`
            : sql`(${workflowRuns.sandboxObserved}, ${workflowRuns.sandboxObservedGeneration}, ${workflowRuns.sandboxAttach}, ${workflowRuns.sandboxError}) is distinct from (${report.observed}::sandbox_state, ${generation}::integer, ${attach === null ? null : JSON.stringify(attach)}::jsonb, null::text)`,
        ),
      )
      .returning({ id: workflowRuns.id });
    return run;
  }

  // Call it in a transaction: the runs stay locked until the transaction ends.
  lockHeldBy(runnerId: number, holder: string) {
    return this.lockLeasedWhere(
      and(eq(workflowRuns.runnerId, runnerId), eq(workflowRuns.leaseHolder, holder)),
    );
  }

  // Call it in a transaction: the runs stay locked until the transaction ends.
  lockExpired() {
    return this.lockLeasedWhere(expired);
  }

  private selectWithRepo() {
    return this.db
      .select(withRepo)
      .from(workflowRuns)
      .innerJoin(workflowSnapshots, eq(workflowSnapshots.id, workflowRuns.workflowSnapshotId))
      .innerJoin(repos, eq(repos.id, workflowRuns.repoId))
      .$dynamic();
  }

  // An undelivered message continues the run.
  private waitsLongerThan(hours: number) {
    const overdueItem = this.db
      .select({ id: inboxItems.id })
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.workflowRunId, workflowRuns.id),
          isNull(inboxItems.resolvedAt),
          lte(inboxItems.createdAt, sql`now() - make_interval(hours => ${hours})`),
        ),
      );
    const undeliveredMessage = this.db
      .select({ id: agentMessages.id })
      .from(agentMessages)
      .where(
        and(eq(agentMessages.workflowRunId, workflowRuns.id), isNull(agentMessages.deliveredAt)),
      );
    return and(
      inArray(workflowRuns.status, ["queued", "waiting_input"]),
      isNull(workflowRuns.cancelRequestedAt),
      exists(overdueItem),
      notExists(undeliveredMessage),
    );
  }

  private async lockLeasedWhere(where?: SQL) {
    const runs = await this.db
      .select({
        id: workflowRuns.id,
        leaseToken: workflowRuns.leaseToken,
        expired: sql<boolean>`${expired}`,
        cancelRequestedAt: workflowRuns.cancelRequestedAt,
      })
      .from(workflowRuns)
      .where(and(leased, where))
      .orderBy(asc(workflowRuns.id))
      .for("update");
    return runs.map(({ leaseToken, ...run }) => {
      if (!leaseToken) throw new Error(`Run ${run.id} is leased without a lease token`);
      return { ...run, leaseToken };
    });
  }
}
