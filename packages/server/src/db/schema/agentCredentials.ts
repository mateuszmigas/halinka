import type { InferSelectModel } from "drizzle-orm";
import { integer, pgTable, text, unique } from "drizzle-orm/pg-core";

import { members } from "./members";
import { createdAt, updatedAt } from "./shared";

// `memberId`: null is the key of the team
export const agentCredentials = pgTable(
  "agent_credentials",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    preset: text().notNull(),
    variable: text().notNull(),
    memberId: integer().references(() => members.id, { onDelete: "cascade" }),
    sealed: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("agent_credentials_preset_variable_member_id_unique")
      .on(table.preset, table.variable, table.memberId)
      .nullsNotDistinct(),
  ],
);

export type DbAgentCredential = InferSelectModel<typeof agentCredentials>;
