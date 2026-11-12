import type { InferSelectModel } from "drizzle-orm";
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { members } from "./members";
import { createdAt } from "./shared";

// A request of `halinka login`, then its token after the exchange.
export const cliLogins = pgTable("cli_logins", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  userCode: text().unique("cli_logins_user_code_unique"),
  deviceCodeHash: text().unique("cli_logins_device_code_hash_unique"),
  tokenHash: text().unique("cli_logins_token_hash_unique"),
  memberId: integer().references(() => members.id, { onDelete: "cascade" }),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export type DbCliLogin = InferSelectModel<typeof cliLogins>;
