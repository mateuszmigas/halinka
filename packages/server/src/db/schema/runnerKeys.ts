import { sql } from "drizzle-orm";
import { integer, pgEnum, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { runners } from "./runners";
import { createdAt, updatedAt } from "./shared";

// The first hello with a `pending` key makes it `current` and retires the old key.
export const runnerKeyState = pgEnum("runner_key_state", ["pending", "current", "retired"]);

export type DbRunnerKeyState = (typeof runnerKeyState.enumValues)[number];

export const runnerKeys = pgTable(
  "runner_keys",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    runnerId: integer()
      .notNull()
      .references(() => runners.id),
    // Ed25519, base64url, the canonical form only
    publicKey: text().notNull().unique("runner_keys_public_key_unique"),
    state: runnerKeyState().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("runner_keys_current_idx")
      .on(table.runnerId)
      .where(sql`${table.state} = 'current'`),
    uniqueIndex("runner_keys_pending_idx")
      .on(table.runnerId)
      .where(sql`${table.state} = 'pending'`),
  ],
);
