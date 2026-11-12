import { integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

import { createdAt } from "./shared";
import { workflowRuns } from "./workflowRuns";

// The event batches a run stored, so a batch the runner sends again is not stored twice.
export const workflowRunEventBatches = pgTable(
  "workflow_run_event_batches",
  {
    workflowRunId: integer()
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    batchId: text().notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.workflowRunId, table.batchId] })],
);
