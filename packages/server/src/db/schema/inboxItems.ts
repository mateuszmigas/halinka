import {
  type AgentAnswer,
  type AgentQuestions,
  type DecisionItemKind,
  inboxItemDecisions,
  inboxItemKinds,
} from "@halinka/protocol";
import { type InferSelectModel, isNull, sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { createdAt } from "./shared";
import { stepAttempts } from "./stepAttempts";
import { stepRuns } from "./stepRuns";
import { workflowRuns } from "./workflowRuns";

export const inboxItemKind = pgEnum("inbox_item_kind", inboxItemKinds);

export const inboxDecision = pgEnum("inbox_decision", inboxItemDecisions);

export const inboxItems = pgTable(
  "inbox_items",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    workflowRunId: integer()
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    stepRunId: integer()
      .notNull()
      .references(() => stepRuns.id, { onDelete: "cascade" }),
    // null on an approval item
    stepAttemptId: integer().references(() => stepAttempts.id, { onDelete: "cascade" }),
    kind: inboxItemKind().notNull(),
    // null on a question item: its questions hold the text
    message: text(),
    // only on a question item
    questions: jsonb().$type<AgentQuestions>(),
    answer: jsonb().$type<AgentAnswer>(),
    // null on a resolved item: the run ended before a person decided
    decision: inboxDecision(),
    note: text(),
    resolvedBy: text(),
    resolvedAt: timestamp({ withTimezone: true }),
    deliveredAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index("inbox_items_workflow_run_id_idx").on(table.workflowRunId),
    index("inbox_items_step_run_id_idx").on(table.stepRunId),
    uniqueIndex("inbox_items_attempt_item_idx")
      .on(table.stepAttemptId)
      .where(isNull(table.questions)),
    index("inbox_items_undelivered_idx")
      .on(table.workflowRunId)
      .where(sql`${table.decision} is not null and ${table.deliveredAt} is null`),
    index("inbox_items_pending_idx")
      .on(table.id)
      .where(sql`${table.resolvedAt} is null`),
  ],
);

// Not checked in the database; `InboxItemRepository.create` keeps this rule.
export type InboxItemVariant =
  | { kind: DecisionItemKind; message: string; questions?: null }
  | { kind: "question"; message?: null; questions: AgentQuestions };

export type DbInboxItem = Omit<
  InferSelectModel<typeof inboxItems>,
  "kind" | "message" | "questions"
> &
  InboxItemVariant;
