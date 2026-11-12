import type { InferSelectModel } from "drizzle-orm";
import { integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

import { repos } from "./repos";
import { updatedAt } from "./shared";

// The commit that the last "Push branch" left on GitHub: the lease of the next push of the branch.
export const pushedBranches = pgTable(
  "pushed_branches",
  {
    repoId: integer()
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    branch: text().notNull(),
    commit: text().notNull(),
    pullRequestUrl: text(),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.repoId, table.branch] })],
);

export type DbPushedBranch = InferSelectModel<typeof pushedBranches>;
