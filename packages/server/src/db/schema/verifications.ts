import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { createdAt, updatedAt } from "./shared";

export const verifications = pgTable(
  "verifications",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)],
);
