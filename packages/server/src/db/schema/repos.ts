import { type RepoPlace, repoKinds } from "@halinka/protocol";
import { type InferSelectModel, sql } from "drizzle-orm";
import {
  bigint,
  check,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { runners } from "./runners";
import { createdAt } from "./shared";

export const repoKind = pgEnum("repo_kind", repoKinds);

export const repos = pgTable(
  "repos",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    kind: repoKind().notNull().default("local"),
    name: text().notNull(),
    path: text(),
    runnerId: integer().references(() => runners.id),
    // null: the `gh` login of the runner pushes. No foreign key: the link outlives a deleted repo row.
    githubRepoId: bigint({ mode: "number" }),
    // the row is deleted with its last run
    deletingAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    unique("repos_runner_id_path_unique").on(table.runnerId, table.path),
    uniqueIndex("repos_github_repo_idx")
      .on(table.githubRepoId)
      .where(sql`${table.kind} = 'github'`),
    check(
      "repos_kind_check",
      sql`(${table.kind} = 'local' and ${table.runnerId} is not null and ${table.path} is not null) or (${table.kind} = 'github' and ${table.runnerId} is null and ${table.path} is null and ${table.githubRepoId} is not null)`,
    ),
  ],
);

export type DbRepo = InferSelectModel<typeof repos>;

export type LocalRepo = DbRepo & { kind: "local"; runnerId: number; path: string };

export const isLocalRepo = (repo: DbRepo): repo is LocalRepo => repo.kind === "local";

// `repos_kind_check` gives a local repo its path and a `github` repo its GitHub id.
export const repoPlaceOf = ({
  repoKind,
  repoPath,
  githubRepoId,
}: {
  repoKind: DbRepo["kind"];
  repoPath: string | null;
  githubRepoId: number | null;
}): RepoPlace => {
  if (repoKind === "local" && repoPath !== null) return { repoPath };
  if (repoKind === "github" && githubRepoId !== null) return { githubRepoId };
  throw new Error(`A ${repoKind} repo has no place`);
};
