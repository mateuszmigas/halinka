import type { AgentMessage } from "@halinka/protocol";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Db } from "../client";
import { agentMessages, type DbAgentMessage, stepAttempts, stepRuns } from "../schema";

const undelivered = isNull(agentMessages.deliveredAt);

export class AgentMessageRepository {
  constructor(private readonly db: Db) {}

  async create(
    message: Pick<
      typeof agentMessages.$inferInsert,
      "workflowRunId" | "stepRunId" | "text" | "author"
    >,
  ): Promise<DbAgentMessage> {
    const [created] = await this.db.insert(agentMessages).values(message).returning();
    if (!created) throw new Error("The message was not stored");
    return created;
  }

  async hasUndelivered(stepRunId: number) {
    const [message] = await this.db
      .select({ id: agentMessages.id })
      .from(agentMessages)
      .where(and(eq(agentMessages.stepRunId, stepRunId), undelivered))
      .limit(1);
    return message !== undefined;
  }

  listUndeliveredByRun(workflowRunId: number): Promise<DbAgentMessage[]> {
    return this.db
      .select()
      .from(agentMessages)
      .where(and(eq(agentMessages.workflowRunId, workflowRunId), undelivered))
      .orderBy(asc(agentMessages.id));
  }

  listUndelivered(workflowRunIds: number[]): Promise<AgentMessage[]> {
    if (workflowRunIds.length === 0) return Promise.resolve([]);
    return this.db
      .select({
        workflowRunId: agentMessages.workflowRunId,
        messageId: agentMessages.id,
        stepRunId: agentMessages.stepRunId,
        text: agentMessages.text,
        author: agentMessages.author,
      })
      .from(agentMessages)
      .innerJoin(stepRuns, eq(stepRuns.id, agentMessages.stepRunId))
      .where(
        and(
          inArray(agentMessages.workflowRunId, workflowRunIds),
          undelivered,
          eq(stepRuns.status, "running"),
        ),
      )
      .orderBy(asc(agentMessages.id));
  }

  async markDelivered(workflowRunId: number, attemptId: number, messageIds: number[]) {
    const stepRunOfAttempt = this.db
      .select({ stepRunId: stepAttempts.stepRunId })
      .from(stepAttempts)
      .where(eq(stepAttempts.id, attemptId));
    await this.db
      .update(agentMessages)
      .set({ stepAttemptId: attemptId, deliveredAt: sql`now()` })
      .where(
        and(
          inArray(agentMessages.id, messageIds),
          eq(agentMessages.workflowRunId, workflowRunId),
          inArray(agentMessages.stepRunId, stepRunOfAttempt),
          undelivered,
        ),
      );
  }
}
