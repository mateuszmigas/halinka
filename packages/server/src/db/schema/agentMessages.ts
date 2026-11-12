import { type InferSelectModel, isNull } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { createdAt } from "./shared";
import { stepAttempts } from "./stepAttempts";
import { stepRuns } from "./stepRuns";
import { workflowRuns } from "./workflowRuns";

export const agentMessages = pgTable(
  "agent_messages",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    workflowRunId: integer()
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    stepRunId: integer()
      .notNull()
      .references(() => stepRuns.id, { onDelete: "cascade" }),
    // the attempt of the prompt that carried the message
    stepAttemptId: integer().references(() => stepAttempts.id, { onDelete: "cascade" }),
    text: text().notNull(),
    author: text().notNull(),
    createdAt: createdAt(),
    deliveredAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    index("agent_messages_step_run_id_idx").on(table.stepRunId),
    index("agent_messages_undelivered_idx")
      .on(table.workflowRunId)
      .where(isNull(table.deliveredAt)),
  ],
);

export type DbAgentMessage = InferSelectModel<typeof agentMessages>;
