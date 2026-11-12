import type { InferSelectModel } from "drizzle-orm";
import { integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

import { repos } from "./repos";
import { createdAt } from "./shared";

export const workflowSchedules = pgTable(
  "workflow_schedules",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    repoId: integer()
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    path: text().notNull(),
    schedule: text().notNull(),
    nextFireAt: timestamp({ withTimezone: true }).notNull(),
    lastFireAt: timestamp({ withTimezone: true }),
    lastResult: text(),
    createdAt: createdAt(),
  },
  (table) => [unique("workflow_schedules_repo_id_path_unique").on(table.repoId, table.path)],
);

export type DbWorkflowSchedule = InferSelectModel<typeof workflowSchedules>;
