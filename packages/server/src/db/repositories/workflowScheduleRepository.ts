import { and, asc, eq, lte, ne, notInArray, sql } from "drizzle-orm";

import type { Db } from "../client";
import { type DbWorkflowSchedule, workflowSchedules } from "../schema";

export type ScheduleOfFile = { path: string; schedule: string; nextFireAt: Date };

export class WorkflowScheduleRepository {
  constructor(private readonly db: Db) {}

  // Call it in a transaction.
  async rewrite(repoId: number, schedules: ScheduleOfFile[], keptPaths: string[]) {
    await this.db
      .delete(workflowSchedules)
      .where(
        and(
          eq(workflowSchedules.repoId, repoId),
          notInArray(workflowSchedules.path, [...schedules.map(({ path }) => path), ...keptPaths]),
        ),
      );
    if (schedules.length === 0) return;
    await this.db
      .insert(workflowSchedules)
      .values(schedules.map((schedule) => ({ repoId, ...schedule })))
      .onConflictDoUpdate({
        target: [workflowSchedules.repoId, workflowSchedules.path],
        set: { schedule: sql`excluded.schedule`, nextFireAt: sql`excluded.next_fire_at` },
        where: ne(workflowSchedules.schedule, sql`excluded.schedule`),
      });
  }

  async findDue(now: Date): Promise<DbWorkflowSchedule[]> {
    return this.db
      .select()
      .from(workflowSchedules)
      .where(lte(workflowSchedules.nextFireAt, now))
      .orderBy(asc(workflowSchedules.nextFireAt));
  }

  // undefined: another write changed the row after the read
  async moveNextFire(
    { id, nextFireAt }: DbWorkflowSchedule,
    next: Date,
  ): Promise<DbWorkflowSchedule | undefined> {
    const [claimed] = await this.db
      .update(workflowSchedules)
      .set({ nextFireAt: next })
      .where(and(eq(workflowSchedules.id, id), eq(workflowSchedules.nextFireAt, nextFireAt)))
      .returning();
    return claimed;
  }

  async record(id: number, lastResult: string) {
    await this.db
      .update(workflowSchedules)
      .set({ lastResult, lastFireAt: sql`now()` })
      .where(eq(workflowSchedules.id, id));
  }
}
