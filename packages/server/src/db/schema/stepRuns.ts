import { type StepRunResult, stepRunStatuses } from "@halinka/protocol";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { updatedAt } from "./shared";
import { workflowRuns } from "./workflowRuns";

export const stepStatus = pgEnum("step_status", stepRunStatuses);

export const stepRuns = pgTable(
  "step_runs",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    workflowRunId: integer()
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    stepId: text().notNull(),
    parentStepRunId: integer().references((): AnyPgColumn => stepRuns.id, { onDelete: "cascade" }),
    iteration: integer(),
    status: stepStatus().notNull().default("running"),
    summary: text(),
    outcome: text(),
    outputs: jsonb().$type<NonNullable<StepRunResult["outputs"]>>(),
    // a reopen: the step run it replaced, and the commits of the rewind
    reopenedStepRunId: integer().references((): AnyPgColumn => stepRuns.id, {
      onDelete: "cascade",
    }),
    reopenBefore: text(),
    reopenAfter: text(),
    // of a `comment_on_pull_request` step, so a repeat posts nothing
    commentUrl: text(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("step_runs_workflow_run_id_step_id_idx").on(table.workflowRunId, table.stepId),
    check(
      "step_runs_iteration_check",
      sql`(${table.parentStepRunId} is null) = (${table.iteration} is null) and ${table.iteration} >= 1`,
    ),
  ],
);
