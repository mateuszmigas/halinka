import type { EventBatch, RunEvent } from "@halinka/protocol";
import { and, asc, eq, gt } from "drizzle-orm";

import type { Db } from "../client";
import { workflowRunEventBatches, workflowRunEvents } from "../schema";

export type StoredRunEvent = { seq: number; createdAt: Date; event: RunEvent };

export class WorkflowRunEventRepository {
  constructor(private readonly db: Db) {}

  async listByRun(workflowRunId: number, afterSeq: number): Promise<StoredRunEvent[]> {
    const events = await this.db
      .select({
        seq: workflowRunEvents.seq,
        createdAt: workflowRunEvents.createdAt,
        event: { kind: workflowRunEvents.kind, payload: workflowRunEvents.payload },
      })
      .from(workflowRunEvents)
      .where(
        and(
          eq(workflowRunEvents.workflowRunId, workflowRunId),
          gt(workflowRunEvents.seq, afterSeq),
        ),
      )
      .orderBy(asc(workflowRunEvents.seq));
    // `append` writes each row from one RunEvent.
    return events as StoredRunEvent[];
  }

  // Call it in a transaction, so a batch is stored with all its events or not at all.
  async append(workflowRunId: number, { batchId, events }: EventBatch) {
    const [batch] = await this.db
      .insert(workflowRunEventBatches)
      .values({ workflowRunId, batchId })
      .onConflictDoNothing()
      .returning({ batchId: workflowRunEventBatches.batchId });
    if (!batch) return undefined;
    if (events.length > 0) {
      await this.db
        .insert(workflowRunEvents)
        .values(events.map((event) => ({ workflowRunId, ...event })));
    }
    return batch;
  }
}
