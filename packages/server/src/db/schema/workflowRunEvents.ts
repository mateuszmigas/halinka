import type { RunEvent } from "@halinka/protocol";
import { bigint, index, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";

import { createdAt } from "./shared";
import { workflowRuns } from "./workflowRuns";

export const workflowRunEvents = pgTable(
  "workflow_run_events",
  {
    seq: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    workflowRunId: integer()
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    kind: text().$type<RunEvent["kind"]>().notNull(),
    payload: jsonb().$type<RunEvent["payload"]>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("workflow_run_events_workflow_run_id_seq_idx").on(table.workflowRunId, table.seq),
  ],
);
