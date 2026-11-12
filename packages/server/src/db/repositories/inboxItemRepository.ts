import {
  type AgentAnswer,
  type AttemptItemKind,
  attemptItemKinds,
  type InboxItemDecision,
} from "@halinka/protocol";
import {
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import type { Db } from "../client";
import {
  type DbInboxItem,
  type InboxItemVariant,
  inboxItems,
  repos,
  stepAttempts,
  stepRuns,
  workflowRuns,
  workflowSnapshots,
} from "../schema";
import { type RunLabel, runLabel } from "./runLabel";

const pending = isNull(inboxItems.resolvedAt);

const undelivered = isNull(inboxItems.deliveredAt);

type NewInboxItem = Pick<
  typeof inboxItems.$inferInsert,
  "workflowRunId" | "stepRunId" | "stepAttemptId"
> &
  InboxItemVariant;

type RunInboxItem = DbInboxItem & { stepId: string };

const toItem = (row: typeof inboxItems.$inferSelect | undefined) => row as DbInboxItem | undefined;

export class InboxItemRepository {
  constructor(private readonly db: Db) {}

  async create(item: NewInboxItem): Promise<DbInboxItem> {
    const [created] = await this.db.insert(inboxItems).values(item).returning();
    if (!created) throw new Error("The inbox item was not stored");
    return created as DbInboxItem;
  }

  async findById(id: number): Promise<DbInboxItem | undefined> {
    const [item] = await this.db.select().from(inboxItems).where(eq(inboxItems.id, id));
    return toItem(item);
  }

  async findApproval(stepRunId: number): Promise<DbInboxItem | undefined> {
    const [item] = await this.db
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.stepRunId, stepRunId), eq(inboxItems.kind, "approval")));
    return toItem(item);
  }

  async listPending(): Promise<(RunInboxItem & RunLabel)[]> {
    const items = await this.db
      .select({ ...getTableColumns(inboxItems), stepId: stepRuns.stepId, ...runLabel })
      .from(inboxItems)
      .innerJoin(stepRuns, eq(stepRuns.id, inboxItems.stepRunId))
      .innerJoin(workflowRuns, eq(workflowRuns.id, inboxItems.workflowRunId))
      .innerJoin(workflowSnapshots, eq(workflowSnapshots.id, workflowRuns.workflowSnapshotId))
      .innerJoin(repos, eq(repos.id, workflowRuns.repoId))
      .where(pending)
      .orderBy(asc(inboxItems.id));
    return items as (RunInboxItem & RunLabel)[];
  }

  async listByRun(workflowRunId: number): Promise<RunInboxItem[]> {
    const items = await this.db
      .select({ ...getTableColumns(inboxItems), stepId: stepRuns.stepId })
      .from(inboxItems)
      .innerJoin(stepRuns, eq(stepRuns.id, inboxItems.stepRunId))
      .where(eq(inboxItems.workflowRunId, workflowRunId))
      .orderBy(asc(inboxItems.id));
    return items as RunInboxItem[];
  }

  listAnswers(workflowRunIds: number[]) {
    if (workflowRunIds.length === 0) return Promise.resolve([]);
    return this.db
      .select({
        workflowRunId: inboxItems.workflowRunId,
        itemId: inboxItems.id,
        decision: sql<InboxItemDecision>`${inboxItems.decision}`,
        note: inboxItems.note,
        answer: inboxItems.answer,
        resolvedBy: sql<string>`${inboxItems.resolvedBy}`,
      })
      .from(inboxItems)
      .innerJoin(stepRuns, eq(stepRuns.id, inboxItems.stepRunId))
      .leftJoin(stepAttempts, eq(stepAttempts.id, inboxItems.stepAttemptId))
      .where(
        and(
          inArray(inboxItems.workflowRunId, workflowRunIds),
          isNotNull(inboxItems.decision),
          undelivered,
          eq(stepRuns.status, "running"),
          // A new attempt does not wait for an earlier question.
          or(ne(inboxItems.kind, "question"), eq(stepAttempts.status, "running")),
        ),
      )
      .orderBy(asc(inboxItems.id));
  }

  async resolve(
    id: number,
    answer: {
      decision: InboxItemDecision;
      note: string | null;
      answer: AgentAnswer | null;
      resolvedBy: string;
    },
  ): Promise<DbInboxItem | undefined> {
    const [item] = await this.db
      .update(inboxItems)
      .set({ ...answer, resolvedAt: sql`now()` })
      .where(and(eq(inboxItems.id, id), pending))
      .returning();
    return toItem(item);
  }

  async markAnswerDelivered(workflowRunId: number, attemptId: number, itemId: number) {
    await this.deliver(
      eq(inboxItems.workflowRunId, workflowRunId),
      eq(inboxItems.stepAttemptId, attemptId),
      eq(inboxItems.id, itemId),
      eq(inboxItems.kind, "question"),
    );
  }

  // An approval item has no attempt: its step can start an attempt before the engine asks for it.
  async markAttemptItemsDelivered(stepRunId: number) {
    await this.deliver(eq(inboxItems.stepRunId, stepRunId), isNotNull(inboxItems.stepAttemptId));
  }

  async findPendingAttemptItem(stepRunId: number) {
    const [item] = await this.db
      .select({ id: inboxItems.id, kind: sql<AttemptItemKind>`${inboxItems.kind}` })
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.stepRunId, stepRunId),
          inArray(inboxItems.kind, [...attemptItemKinds]),
          pending,
        ),
      )
      .limit(1);
    return item;
  }

  async closePending(workflowRunId: number) {
    await this.close(eq(inboxItems.workflowRunId, workflowRunId));
  }

  async closePendingByStepRun(...stepRunIds: number[]) {
    await this.close(inArray(inboxItems.stepRunId, stepRunIds));
  }

  // Returns whether it closed a question.
  async closeQuestionsOfEndedAttempts(workflowRunId: number) {
    const runningAttempt = this.db
      .select({ id: stepAttempts.id })
      .from(stepAttempts)
      .where(
        and(eq(stepAttempts.id, inboxItems.stepAttemptId), eq(stepAttempts.status, "running")),
      );
    const closed = await this.close(
      eq(inboxItems.workflowRunId, workflowRunId),
      eq(inboxItems.kind, "question"),
      notExists(runningAttempt),
    );
    return closed > 0;
  }

  async closeQuestionsByAttempt(workflowRunId: number, attemptId: number) {
    const closed = await this.close(
      eq(inboxItems.workflowRunId, workflowRunId),
      eq(inboxItems.stepAttemptId, attemptId),
      eq(inboxItems.kind, "question"),
    );
    return closed > 0;
  }

  private async deliver(...where: SQL[]) {
    await this.db
      .update(inboxItems)
      .set({ deliveredAt: sql`now()` })
      .where(and(...where, isNotNull(inboxItems.decision), undelivered));
  }

  private async close(...where: SQL[]) {
    const closed = await this.db
      .update(inboxItems)
      .set({ resolvedBy: "halinka", resolvedAt: sql`now()` })
      .where(and(...where, pending))
      .returning({ id: inboxItems.id });
    return closed.length;
  }
}
