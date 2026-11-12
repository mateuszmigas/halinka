import {
  attemptItemKinds,
  isAttemptItemKind,
  limitChangedFiles,
  type RecordedStep,
  type RecordedStepStatus,
  type ReopenedStep,
  type ToldToAgent,
  type StepFacts,
  type StepParent,
  type StepResult,
  type StepRunResult,
} from "@halinka/protocol";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  ne,
  sql,
  sum,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import type { Db } from "../client";
import { agentMessages, inboxItems, stepAttempts, stepRuns } from "../schema";

type StoredReport = {
  summary: string | null;
  outcome: string | null;
  outputs: NonNullable<StepRunResult["outputs"]> | null;
};

const reportOf = ({ summary, outcome, outputs }: StoredReport) => ({
  ...(summary !== null && { summary }),
  ...(outcome !== null && { outcome }),
  ...(outputs !== null && { outputs }),
});

const withReport = <T extends StoredReport>({ summary, outcome, outputs, ...row }: T) => ({
  ...row,
  ...reportOf({ summary, outcome, outputs }),
});

const parentOf = (stepRunId: number | null, iteration: number | null) =>
  stepRunId === null || iteration === null ? {} : { parent: { stepRunId, iteration } };

// A lost attempt can have a cost without a time: the cost of a session that it replaced.
const usageOf = (activeMs: number | null, costUsd: number | null) =>
  activeMs === null && costUsd === null
    ? {}
    : { usage: { activeMs: activeMs ?? 0, ...(costUsd !== null && { costUsd }) } };

const attemptValuesOf = (
  commit: string | null,
  sessionId: string | null,
  changedFiles: string[],
) => ({
  ...(commit !== null && { commit }),
  ...(sessionId !== null && { sessionId }),
  ...(changedFiles.length > 0 && limitChangedFiles(changedFiles)),
});

const attemptsOf = eq(stepAttempts.stepRunId, stepRuns.id);

const sumOfAttempts = (column: AnyPgColumn) =>
  sql<number | null>`(select sum(${column}) from ${stepAttempts} where ${attemptsOf})`.mapWith(
    Number,
  );

const lastOfAttempts = (column: AnyPgColumn) =>
  sql<string | null>`(select ${column} from ${stepAttempts}
    where ${attemptsOf} and ${column} is not null order by ${stepAttempts.attempt} desc limit 1)`;

const changedFilesOfAttempts = sql<
  string[]
>`array(select distinct unnest(${stepAttempts.changedFiles})
    from ${stepAttempts} where ${attemptsOf})`;

const factColumns = {
  activeMs: sumOfAttempts(stepAttempts.activeMs),
  costUsd: sumOfAttempts(stepAttempts.costUsd),
  commit: lastOfAttempts(stepAttempts.commitAfter),
  sessionId: lastOfAttempts(stepAttempts.sessionId),
  changedFiles: changedFilesOfAttempts,
};

type FactRow = {
  activeMs: number | null;
  costUsd: number | null;
  commit: string | null;
  sessionId: string | null;
  changedFiles: string[];
};

const factsOf = ({ activeMs, costUsd, commit, sessionId, changedFiles }: FactRow): StepFacts => ({
  ...usageOf(activeMs, costUsd),
  ...attemptValuesOf(commit, sessionId, changedFiles),
});

const notSuperseded = ne(stepRuns.status, "superseded");

const stepRunOf = (workflowRunId: number, stepRunId: number) =>
  and(eq(stepRuns.id, stepRunId), eq(stepRuns.workflowRunId, workflowRunId));

type Reopen = { reopenedStepRunId: number; reopenBefore: string; reopenAfter: string };

export type LastReopen = NonNullable<Awaited<ReturnType<StepRunRepository["findLastReopen"]>>>;

const runningStepRun = (workflowRunId: number, stepRunId: number) =>
  and(
    eq(stepRuns.id, stepRunId),
    eq(stepRuns.workflowRunId, workflowRunId),
    eq(stepRuns.status, "running"),
  );

type StartStepOptions = { parent?: StepParent; reopen?: Reopen };

export class StepRunRepository {
  constructor(private readonly db: Db) {}

  async listByRun(workflowRunId: number) {
    const rows = await this.db
      .select({
        ...getTableColumns(stepRuns),
        costUsd: sumOfAttempts(stepAttempts.costUsd),
        commit: lastOfAttempts(stepAttempts.commitAfter),
        sessionId: lastOfAttempts(stepAttempts.sessionId),
        changedFiles: changedFilesOfAttempts,
      })
      .from(stepRuns)
      .where(eq(stepRuns.workflowRunId, workflowRunId))
      .orderBy(asc(stepRuns.id));
    return rows.map(({ costUsd, commit, sessionId, changedFiles, ...row }) => ({
      ...row,
      ...(costUsd !== null && { usage: { costUsd } }),
      ...attemptValuesOf(commit, sessionId, changedFiles),
    }));
  }

  async listRecorded(workflowRunId: number, lastReopen?: LastReopen): Promise<RecordedStep[]> {
    const stored = await this.db
      .select({
        stepRunId: stepRuns.id,
        stepId: stepRuns.stepId,
        status: sql<RecordedStepStatus>`${stepRuns.status}`,
        summary: stepRuns.summary,
        outcome: stepRuns.outcome,
        outputs: stepRuns.outputs,
        failedAttempts: this.db.$count(
          stepAttempts,
          and(attemptsOf, eq(stepAttempts.status, "failed")),
        ),
        parentStepRunId: stepRuns.parentStepRunId,
        iteration: stepRuns.iteration,
        ...factColumns,
      })
      .from(stepRuns)
      .where(and(eq(stepRuns.workflowRunId, workflowRunId), notSuperseded))
      .orderBy(asc(stepRuns.id));
    const rows = stored.map(
      ({
        parentStepRunId,
        iteration,
        activeMs,
        costUsd,
        commit,
        sessionId,
        changedFiles,
        ...row
      }) => ({
        ...withReport(row),
        ...parentOf(parentStepRunId, iteration),
        ...factsOf({ activeMs, costUsd, commit, sessionId, changedFiles }),
      }),
    );
    if (!rows.some(({ status }) => status === "running")) return rows;
    const lastAttempts = await this.db
      .selectDistinctOn([stepAttempts.stepRunId], {
        stepRunId: stepAttempts.stepRunId,
        summary: stepAttempts.summary,
        outcome: stepAttempts.outcome,
        outputs: stepAttempts.outputs,
        itemId: inboxItems.id,
        kind: inboxItems.kind,
      })
      .from(stepAttempts)
      .innerJoin(stepRuns, eq(stepRuns.id, stepAttempts.stepRunId))
      .leftJoin(
        inboxItems,
        and(
          eq(inboxItems.stepAttemptId, stepAttempts.id),
          inArray(inboxItems.kind, [...attemptItemKinds]),
        ),
      )
      .where(and(eq(stepRuns.workflowRunId, workflowRunId), eq(stepRuns.status, "running")))
      .orderBy(stepAttempts.stepRunId, desc(stepAttempts.id));
    const attemptItems = new Map(
      lastAttempts.flatMap(({ stepRunId, itemId, kind, ...report }) =>
        itemId === null || kind === null || !isAttemptItemKind(kind)
          ? []
          : [[stepRunId, { itemId, kind, ...reportOf(report) }]],
      ),
    );
    const reopen =
      lastReopen &&
      rows.some(({ stepRunId, status }) => stepRunId === lastReopen.id && status === "running")
        ? lastReopen
        : undefined;
    const sessions = [
      ...new Set(
        rows.flatMap(({ status, sessionId }) =>
          status === "running" && sessionId ? [sessionId] : [],
        ),
      ),
    ];
    const [reopened, costs, told] = await Promise.all([
      reopen && this.reopenedOf(workflowRunId, reopen.replacedId),
      Promise.all(
        sessions.map(async (id) => [id, await this.sessionCostOf(workflowRunId, id)] as const),
      ).then((entries) => new Map(entries)),
      this.toldOfRunning(workflowRunId, rows),
    ]);
    return rows.map((row) => {
      const attemptItem = attemptItems.get(row.stepRunId);
      const toldOfRow = told.get(row.stepRunId) ?? [];
      const sessionCostUsd =
        row.status === "running" && row.sessionId ? costs.get(row.sessionId) : undefined;
      return {
        ...row,
        ...(sessionCostUsd !== undefined && { sessionCostUsd }),
        ...(attemptItem && { attemptItem }),
        ...(reopened && row.stepRunId === reopen?.id && { reopened }),
        ...(toldOfRow.length > 0 && { told: toldOfRow }),
      };
    });
  }

  async readFacts(workflowRunId: number, stepRunId: number) {
    const [row] = await this.db
      .select(factColumns)
      .from(stepRuns)
      .where(stepRunOf(workflowRunId, stepRunId));
    if (!row) throw new Error(`Step run ${stepRunId} of run ${workflowRunId} is missing`);
    return factsOf(row);
  }

  private async toldOfRunning(
    workflowRunId: number,
    rows: { stepRunId: number; status: string }[],
  ) {
    const links = await this.db
      .select({ id: stepRuns.id, reopenedStepRunId: stepRuns.reopenedStepRunId })
      .from(stepRuns)
      .where(eq(stepRuns.workflowRunId, workflowRunId));
    const reopenedIds = new Map(links.map(({ id, reopenedStepRunId }) => [id, reopenedStepRunId]));
    const running = rows.filter(({ status }) => status === "running");
    const entries = await Promise.all(
      running.map(async ({ stepRunId }) => {
        const chain: number[] = [];
        for (let id: number | null | undefined = stepRunId; id; id = reopenedIds.get(id)) {
          chain.push(id);
        }
        return [stepRunId, await this.toldOf(chain)] as const;
      }),
    );
    return new Map(entries);
  }

  private async toldOf(stepRunIds: number[]): Promise<ToldToAgent[]> {
    const [answers, messages] = await Promise.all([
      this.db
        .select({
          questions: inboxItems.questions,
          answer: inboxItems.answer,
          deliveredAt: inboxItems.deliveredAt,
        })
        .from(inboxItems)
        .where(
          and(
            inArray(inboxItems.stepRunId, stepRunIds),
            eq(inboxItems.kind, "question"),
            isNotNull(inboxItems.deliveredAt),
          ),
        )
        .orderBy(asc(inboxItems.id)),
      this.db
        .select({
          author: agentMessages.author,
          text: agentMessages.text,
          deliveredAt: agentMessages.deliveredAt,
        })
        .from(agentMessages)
        .where(
          and(inArray(agentMessages.stepRunId, stepRunIds), isNotNull(agentMessages.deliveredAt)),
        )
        .orderBy(asc(agentMessages.id)),
    ]);
    // Stable: in one prompt, the answer comes before the messages.
    return [
      ...answers.flatMap(({ questions, answer, deliveredAt }) =>
        questions && answer ? [{ deliveredAt, entry: { questions, answer } }] : [],
      ),
      ...messages.map(({ deliveredAt, ...entry }) => ({ deliveredAt, entry })),
    ]
      .toSorted((a, b) => Number(a.deliveredAt) - Number(b.deliveredAt))
      .map(({ entry }) => entry);
  }

  private async reopenedOf(workflowRunId: number, replacedId: number): Promise<ReopenedStep> {
    const [replaced] = await this.db
      .select({
        summary: stepRuns.summary,
        outputs: stepRuns.outputs,
        sessionId: lastOfAttempts(stepAttempts.sessionId),
        changedFiles: changedFilesOfAttempts,
      })
      .from(stepRuns)
      .where(stepRunOf(workflowRunId, replacedId));
    if (!replaced) throw new Error(`Step run ${replacedId} of run ${workflowRunId} is missing`);
    const { summary, outputs, sessionId, changedFiles } = replaced;
    const sessionCostUsd = sessionId
      ? await this.sessionCostOf(workflowRunId, sessionId)
      : undefined;
    return {
      ...reportOf({ summary, outcome: null, outputs }),
      ...attemptValuesOf(null, sessionId, changedFiles),
      ...(sessionCostUsd !== undefined && { sessionCostUsd }),
    };
  }

  // A `lost` attempt has no cost.
  private async sessionCostOf(workflowRunId: number, sessionId: string) {
    const [cost] = await this.db
      .select({ costUsd: sum(stepAttempts.sessionCostUsd).mapWith(Number) })
      .from(stepAttempts)
      .innerJoin(stepRuns, eq(stepRuns.id, stepAttempts.stepRunId))
      .where(and(eq(stepRuns.workflowRunId, workflowRunId), eq(stepAttempts.sessionId, sessionId)));
    return cost?.costUsd ?? undefined;
  }

  async storeComment(stepRunId: number, url: string) {
    await this.db.update(stepRuns).set({ commentUrl: url }).where(eq(stepRuns.id, stepRunId));
  }

  async findLastReopen(workflowRunId: number) {
    const [reopen] = await this.db
      .select({
        id: stepRuns.id,
        replacedId: sql<number>`${stepRuns.reopenedStepRunId}`,
        before: sql<string>`${stepRuns.reopenBefore}`,
        after: sql<string>`${stepRuns.reopenAfter}`,
        attempts: this.db.$count(stepAttempts, attemptsOf),
      })
      .from(stepRuns)
      .where(
        and(
          eq(stepRuns.workflowRunId, workflowRunId),
          isNotNull(stepRuns.reopenedStepRunId),
          notSuperseded,
        ),
      )
      .orderBy(desc(stepRuns.id))
      .limit(1);
    return reopen;
  }

  // Call it in a transaction: the step run stays locked until the transaction ends.
  async lockById(workflowRunId: number, stepRunId: number) {
    const [stepRun] = await this.db
      .select({
        id: stepRuns.id,
        stepId: stepRuns.stepId,
        status: stepRuns.status,
        parentStepRunId: stepRuns.parentStepRunId,
        iteration: stepRuns.iteration,
        reopenBefore: stepRuns.reopenBefore,
        reopenAfter: stepRuns.reopenAfter,
        attempts: this.db.$count(stepAttempts, attemptsOf),
      })
      .from(stepRuns)
      .where(stepRunOf(workflowRunId, stepRunId))
      .for("update", { of: stepRuns });
    if (!stepRun) return undefined;
    const { parentStepRunId, iteration, ...row } = stepRun;
    return { ...row, ...parentOf(parentStepRunId, iteration) };
  }

  async supersedeFrom(workflowRunId: number, stepRunId: number) {
    const superseded = await this.db
      .update(stepRuns)
      .set({ status: "superseded", finishedAt: sql`coalesce(${stepRuns.finishedAt}, now())` })
      .where(
        and(eq(stepRuns.workflowRunId, workflowRunId), gte(stepRuns.id, stepRunId), notSuperseded),
      )
      .returning({ id: stepRuns.id });
    return superseded.map(({ id }) => id);
  }

  async restart(workflowRunId: number, stepRunId: number) {
    await this.db
      .update(stepRuns)
      .set({ status: "running", summary: null, outcome: null, outputs: null, finishedAt: null })
      .where(and(stepRunOf(workflowRunId, stepRunId), notSuperseded));
  }

  async start(workflowRunId: number, stepId: string, { parent, reopen }: StartStepOptions = {}) {
    const [stepRun] = await this.db
      .insert(stepRuns)
      .values({
        workflowRunId,
        stepId,
        parentStepRunId: parent?.stepRunId,
        iteration: parent?.iteration,
        ...reopen,
      })
      .returning({ id: stepRuns.id });
    if (!stepRun) throw new Error(`The step run of ${stepId} was not stored`);
    return stepRun.id;
  }

  // Call it in a transaction: the step run stays locked until the transaction ends.
  async lockRunning(workflowRunId: number, stepRunId: number) {
    const [stepRun] = await this.db
      .select({ id: stepRuns.id, stepId: stepRuns.stepId, commentUrl: stepRuns.commentUrl })
      .from(stepRuns)
      .where(runningStepRun(workflowRunId, stepRunId))
      .for("update");
    return stepRun;
  }

  async finish(
    workflowRunId: number,
    stepRunId: number,
    { status, summary, outcome, outputs }: StepRunResult,
  ) {
    const [stepRun] = await this.db
      .update(stepRuns)
      .set({ status, summary, outcome, outputs, finishedAt: sql`now()` })
      .where(runningStepRun(workflowRunId, stepRunId))
      .returning({ id: stepRuns.id });
    return stepRun;
  }

  async hasRunning(workflowRunId: number) {
    const [stepRun] = await this.db
      .select({ id: stepRuns.id })
      .from(stepRuns)
      .where(and(eq(stepRuns.workflowRunId, workflowRunId), eq(stepRuns.status, "running")))
      .limit(1);
    return stepRun !== undefined;
  }

  async closeRunning(workflowRunId: number, status: StepResult) {
    await this.db
      .update(stepRuns)
      .set({ status, finishedAt: sql`now()` })
      .where(and(eq(stepRuns.workflowRunId, workflowRunId), eq(stepRuns.status, "running")));
  }
}
