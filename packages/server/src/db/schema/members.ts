import type { InferSelectModel } from "drizzle-orm";
import { integer, pgEnum, pgTable, text } from "drizzle-orm/pg-core";

import { createdAt } from "./shared";

export const memberRole = pgEnum("member_role", ["admin", "member"]);

// `githubId`: a login name can pass to another person.
export const members = pgTable("members", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  githubId: text().notNull().unique("members_github_id_unique"),
  login: text().notNull(),
  role: memberRole().notNull(),
  createdAt: createdAt(),
});

export type DbMember = InferSelectModel<typeof members>;
export type DbMemberRole = DbMember["role"];
