import type { InferSelectModel } from "drizzle-orm";
import { integer, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

import { createdAt } from "./shared";
import { workflowRuns } from "./workflowRuns";

// The result of a ControlPlane write with a call id, so a repeat gets it again.
export const runCalls = pgTable(
  "run_calls",
  {
    workflowRunId: integer()
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    callId: text().notNull(),
    // the lease of the first call: only its holder reads the result
    leaseToken: text().notNull(),
    // sha256 hex of the method and the arguments: a repeat must not change them
    callHash: text().notNull(),
    result: jsonb().$type<{ value?: unknown }>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.workflowRunId, table.callId] })],
);

export type DbRunCall = InferSelectModel<typeof runCalls>;
