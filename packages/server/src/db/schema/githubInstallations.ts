import type { InferSelectModel } from "drizzle-orm";
import { bigint, boolean, integer, pgTable, text, unique } from "drizzle-orm/pg-core";

import { gitHubApps } from "./githubApps";
import { createdAt, updatedAt } from "./shared";

export const gitHubInstallations = pgTable(
  "github_installations",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    appId: integer()
      .notNull()
      .references(() => gitHubApps.id, { onDelete: "cascade" }),
    githubId: bigint({ mode: "number" }).notNull(),
    accountLogin: text().notNull(),
    suspended: boolean().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique("github_installations_github_id_unique").on(table.githubId)],
);

export type DbGitHubInstallation = InferSelectModel<typeof gitHubInstallations>;
