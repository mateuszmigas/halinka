import type { AttemptResult } from "@halinka/protocol";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  lt,
  max,
  ne,
  sql,
} from "drizzle-orm";

import type { Db } from "../client";
import {
  type DbStepAttempt,
  members,
  repos,
  stepAttempts,
  stepRuns,
  workflowRuns,
} from "../schema";

const runningOfRun = (workflowRunId: number) =>
  and(
    eq(stepAttempts.status, "running"),
    eq(stepRuns.id, stepAttempts.stepRunId),
    eq(stepRuns.workflowRunId, workflowRunId),
  );

const runningAttemptOf = (workflowRunId: number, attemptId: number) =>
  and(eq(stepAttempts.id, attemptId), runningOfRun(workflowRunId));

// `replacedCostUsd`: the attempt's cost until it finishes, which stores its whole cost
type SetSessionOptions = { sessionId: string; replacedCostUsd?: number };

export class StepAttemptRepository {
  constructor(private readonly db: Db) {}

  // Without the report: the run page reads the attempts often and does not show it.
  listByRun(
    workflowRunId: number,
  ): Promise<Omit<DbStepAttempt, "summary" | "outcome" | "outputs">[]> {
    const { summary: _s, outcome: _o, outputs: _p, ...columns } = getTableColumns(stepAttempts);
    return this.db
      .select(columns)
      .from(stepAttempts)
      .innerJoin(stepRuns, eq(stepRuns.id, stepAttempts.stepRunId))
      .where(eq(stepRuns.workflowRunId, workflowRunId))
      .orderBy(asc(stepAttempts.id));
  }

  // Call it in a transaction after `StepRunRepository.lockRunning`, so the attempt number is unique.
  async start(stepRunId: number) {
    const [last] = await this.db
      .select({ attempt: max(stepAttempts.attempt) })
      .from(stepAttempts)
      .where(eq(stepAttempts.stepRunId, stepRunId));
    const [attempt] = await this.db
      .insert(stepAttempts)
      .values({ stepRunId, attempt: (last?.attempt ?? 0) + 1 })
      .returning({ attemptId: stepAttempts.id, attempt: stepAttempts.attempt });
    if (!attempt) throw new Error(`The attempt of step run ${stepRunId} was not stored`);
    return attempt;
  }

  async listCostTotals(days: number) {
    return this.db
      .select({
        repoId: repos.id,
        repoName: repos.name,
        authorId: members.id,
        authorLogin: members.login,
        costUsd: sql<number>`coalesce(sum(${stepAttempts.costUsd}), 0)`.mapWith(Number),
        attemptsWithNoCost: sql<number>`count(*) - count(${stepAttempts.costUsd})`.mapWith(Number),
      })
      .from(stepAttempts)
      .innerJoin(stepRuns, eq(stepRuns.id, stepAttempts.stepRunId))
      .innerJoin(workflowRuns, eq(workflowRuns.id, stepRuns.workflowRunId))
      .innerJoin(repos, eq(repos.id, workflowRuns.repoId))
      .leftJoin(members, eq(members.id, workflowRuns.authorId))
      .where(
        and(
          gte(stepAttempts.startedAt, sql`now() - make_interval(days => ${days})`),
          // A `lost` or `cancelled` attempt stores no cost: a later attempt in its session counts it.
          sql`(${stepAttempts.costUsd} is not null or (${stepAttempts.sessionId} is not null
            and ${stepAttempts.status} not in ('running', 'lost', 'cancelled')))`,
        ),
      )
      .groupBy(repos.id, members.id);
  }

  // Of the step runs that are not superseded; `from` and `before` limit the step run ids.
  async findLastCheckpoint(
    workflowRunId: number,
    { from, before }: { from?: number; before?: number } = {},
  ) {
    const [attempt] = await this.db
      .select({ commitAfter: stepAttempts.commitAfter })
      .from(stepAttempts)
      .innerJoin(stepRuns, eq(stepRuns.id, stepAttempts.stepRunId))
      .where(
        and(
          eq(stepRuns.workflowRunId, workflowRunId),
          ne(stepRuns.status, "superseded"),
          isNotNull(stepAttempts.commitAfter),
          from === undefined ? undefined : gte(stepRuns.id, from),
          before === undefined ? undefined : lt(stepRuns.id, before),
        ),
      )
      .orderBy(desc(stepAttempts.id))
      .limit(1);
    return attempt?.commitAfter ?? undefined;
  }

  // Of the step runs with an id between `after` and `before`
  async hasAttemptBetween(workflowRunId: number, after: number, before: number) {
    const [attempt] = await this.db
      .select({ id: stepAttempts.id })
      .from(stepAttempts)
      .innerJoin(stepRuns, eq(stepRuns.id, stepAttempts.stepRunId))
      .where(
        and(
          eq(stepRuns.workflowRunId, workflowRunId),
          gt(stepRuns.id, after),
          lt(stepRuns.id, before),
        ),
      )
      .limit(1);
    return attempt !== undefined;
  }

  async findCommits(stepRunId: number) {
    const commits = await this.db
      .select({ before: stepAttempts.commitBefore, after: stepAttempts.commitAfter })
      .from(stepAttempts)
      .where(eq(stepAttempts.stepRunId, stepRunId))
      .orderBy(asc(stepAttempts.attempt));
    return {
      before: commits.find(({ before }) => before !== null)?.before ?? undefined,
      after: commits.findLast(({ after }) => after !== null)?.after ?? undefined,
    };
  }

  async lockRunning(workflowRunId: number, attemptId: number) {
    const [attempt] = await this.db
      .select({ stepRunId: stepAttempts.stepRunId })
      .from(stepAttempts)
      .innerJoin(stepRuns, eq(stepRuns.id, stepAttempts.stepRunId))
      .where(
        and(
          eq(stepAttempts.id, attemptId),
          eq(stepAttempts.status, "running"),
          eq(stepRuns.workflowRunId, workflowRunId),
        ),
      )
      .for("update", { of: stepAttempts });
    return attempt;
  }

  async markLost(...stepRunIds: number[]) {
    await this.db
      .update(stepAttempts)
      .set({ status: "lost", finishedAt: sql`now()` })
      .where(and(inArray(stepAttempts.stepRunId, stepRunIds), eq(stepAttempts.status, "running")));
  }

  async closeRunning(workflowRunId: number, status: "cancelled" | "lost") {
    await this.db
      .update(stepAttempts)
      .set({ status, finishedAt: sql`now()` })
      .from(stepRuns)
      .where(runningOfRun(workflowRunId));
  }

  async setSession(
    workflowRunId: number,
    attemptId: number,
    { sessionId, replacedCostUsd }: SetSessionOptions,
  ) {
    await this.db
      .update(stepAttempts)
      .set({ sessionId, ...(replacedCostUsd !== undefined && { costUsd: replacedCostUsd }) })
      .from(stepRuns)
      .where(runningAttemptOf(workflowRunId, attemptId));
  }

  async finish(
    workflowRunId: number,
    attemptId: number,
    {
      status,
      exitCode,
      checkpoint,
      usage,
      sessionId,
      sessionCostUsd,
      summary,
      outcome,
      outputs,
    }: AttemptResult,
  ) {
    const [attempt] = await this.db
      .update(stepAttempts)
      .set({
        status,
        exitCode,
        summary,
        outcome,
        outputs,
        commitBefore: checkpoint?.before,
        commitAfter: checkpoint?.after,
        changedFiles: checkpoint?.changedFiles,
        activeMs: usage?.activeMs,
        costUsd: usage?.costUsd,
        sessionId,
        sessionCostUsd,
        finishedAt: sql`now()`,
      })
      .from(stepRuns)
      .where(runningAttemptOf(workflowRunId, attemptId))
      .returning({ stepRunId: stepAttempts.stepRunId });
    return attempt;
  }
}
