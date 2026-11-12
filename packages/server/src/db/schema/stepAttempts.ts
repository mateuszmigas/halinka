import { attemptStatuses, type StepRunResult } from "@halinka/protocol";
import type { InferSelectModel } from "drizzle-orm";
import {
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import { updatedAt } from "./shared";
import { stepRuns } from "./stepRuns";

export const attemptStatus = pgEnum("attempt_status", attemptStatuses);

export const stepAttempts = pgTable(
  "step_attempts",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    stepRunId: integer()
      .notNull()
      .references(() => stepRuns.id, { onDelete: "cascade" }),
    attempt: integer().notNull(),
    status: attemptStatus().notNull().default("running"),
    exitCode: integer(),
    summary: text(),
    outcome: text(),
    outputs: jsonb().$type<NonNullable<StepRunResult["outputs"]>>(),
    commitBefore: text(),
    commitAfter: text(),
    changedFiles: text().array(),
    // null when the agent reports no cost
    costUsd: doublePrecision(),
    activeMs: integer(),
    sessionId: text(),
    // the cost in `sessionId`; null when the agent reports no cost
    sessionCostUsd: doublePrecision(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("step_attempts_step_run_id_attempt_unique").on(table.stepRunId, table.attempt),
  ],
);

export type DbStepAttempt = InferSelectModel<typeof stepAttempts>;
