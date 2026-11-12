import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { createdAt, updatedAt } from "./shared";
import { users } from "./users";

export const sessions = pgTable(
  "sessions",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    userId: integer()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text().notNull().unique("sessions_token_unique"),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    ipAddress: text(),
    userAgent: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);
