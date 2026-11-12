import { agentTestStatuses } from "@halinka/protocol";
import { integer, jsonb, pgEnum, pgTable, text, unique } from "drizzle-orm/pg-core";

import { members } from "./members";
import { runners } from "./runners";
import { createdAt, updatedAt } from "./shared";

export const agentTestStatus = pgEnum("agent_test_status", agentTestStatuses);

export const agentTests = pgTable(
  "agent_tests",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    preset: text().notNull(),
    runnerId: integer()
      .notNull()
      .references(() => runners.id, { onDelete: "cascade" }),
    // null is the test of the team
    memberId: integer().references(() => members.id, { onDelete: "cascade" }),
    // fences the result of a replaced test
    token: text().notNull(),
    status: agentTestStatus().notNull(),
    capabilities: jsonb().$type<Record<string, unknown>>(),
    error: text(),
    // see `agentFingerprint`; null until a claim and for a worktree runner
    testedWith: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("agent_tests_runner_id_preset_member_id_unique")
      .on(table.runnerId, table.preset, table.memberId)
      .nullsNotDistinct(),
  ],
);
