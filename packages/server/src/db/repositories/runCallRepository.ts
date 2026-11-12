import { and, eq, inArray, lte, sql } from "drizzle-orm";

import type { Db } from "../client";
import { type DbRunCall, runCalls, workflowRuns } from "../schema";

type NewRunCall = Pick<DbRunCall, "workflowRunId" | "callId" | "leaseToken" | "callHash">;

export class RunCallRepository {
  constructor(private readonly db: Db) {}

  // Call it in a transaction. False for a known call id; a repeat waits until the first call ends.
  async start(call: NewRunCall) {
    const [started] = await this.db
      .insert(runCalls)
      .values({ ...call, result: {} })
      .onConflictDoNothing()
      .returning({ callId: runCalls.callId });
    return started !== undefined;
  }

  async find(workflowRunId: number, callId: string): Promise<DbRunCall | undefined> {
    const [call] = await this.db
      .select()
      .from(runCalls)
      .where(and(eq(runCalls.workflowRunId, workflowRunId), eq(runCalls.callId, callId)));
    return call;
  }

  async deleteByRun(workflowRunId: number) {
    await this.db.delete(runCalls).where(eq(runCalls.workflowRunId, workflowRunId));
  }

  async deleteOfRunsFinishedBefore(hoursAgo: number) {
    const finished = this.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(lte(workflowRuns.finishedAt, sql`now() - make_interval(hours => ${hoursAgo})`));
    await this.db.delete(runCalls).where(inArray(runCalls.workflowRunId, finished));
  }

  async finish(workflowRunId: number, callId: string, value: unknown) {
    await this.db
      .update(runCalls)
      .set({ result: { value } })
      .where(and(eq(runCalls.workflowRunId, workflowRunId), eq(runCalls.callId, callId)));
  }
}
