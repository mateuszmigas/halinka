import { index, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

import { createdAt, updatedAt } from "./shared";
import { users } from "./users";

export const accounts = pgTable(
  "accounts",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    userId: integer()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text().notNull(),
    providerId: text().notNull(),
    // Always null: Halinka does not call GitHub for a user.
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true }),
    scope: text(),
    password: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("accounts_provider_id_account_id_unique").on(table.providerId, table.accountId),
    index("accounts_user_id_idx").on(table.userId),
  ],
);
