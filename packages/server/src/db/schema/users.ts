import { boolean, integer, pgTable, text } from "drizzle-orm/pg-core";

import { createdAt, updatedAt } from "./shared";

// The tables of Better Auth: this one, `sessions`, `accounts` and `verifications`.
export const users = pgTable("users", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: text().notNull(),
  email: text().notNull().unique("users_email_unique"),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  githubId: text().notNull().unique("users_github_id_unique"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
