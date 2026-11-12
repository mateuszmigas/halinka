import type { InferSelectModel } from "drizzle-orm";
import { bigint, index, integer, pgTable, text, unique } from "drizzle-orm/pg-core";

import { gitHubInstallations } from "./githubInstallations";
import { createdAt, updatedAt } from "./shared";

export const gitHubInstallationRepos = pgTable(
  "github_installation_repos",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    installationId: integer()
      .notNull()
      .references(() => gitHubInstallations.id, { onDelete: "cascade" }),
    githubId: bigint({ mode: "number" }).notNull(),
    owner: text().notNull(),
    name: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("github_installation_repos_github_id_unique").on(table.githubId),
    index("github_installation_repos_installation_id_idx").on(table.installationId),
  ],
);

export type DbGitHubInstallationRepo = InferSelectModel<typeof gitHubInstallationRepos>;
