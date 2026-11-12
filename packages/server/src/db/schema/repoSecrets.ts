import type { InferSelectModel } from "drizzle-orm";
import { integer, pgTable, text, unique } from "drizzle-orm/pg-core";

import { repos } from "./repos";
import { createdAt, updatedAt } from "./shared";

export const repoSecrets = pgTable(
  "repo_secrets",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    repoId: integer()
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    name: text().notNull(),
    sealed: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique("repo_secrets_repo_id_name_unique").on(table.repoId, table.name)],
);

export type DbRepoSecret = InferSelectModel<typeof repoSecrets>;
