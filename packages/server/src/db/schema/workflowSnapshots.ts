import type { NetworkHosts, Workflow } from "@halinka/workflow";
import type { InferSelectModel } from "drizzle-orm";
import { boolean, integer, jsonb, pgTable, text, unique } from "drizzle-orm/pg-core";

import { repos } from "./repos";
import { createdAt } from "./shared";

export const workflowSnapshots = pgTable(
  "workflow_snapshots",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    repoId: integer()
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    path: text().notNull(),
    // sha256 of `files`, so an unchanged workflow shares one snapshot
    contentHash: text().notNull(),
    files: jsonb().$type<Record<string, string>>().notNull(),
    resolved: jsonb().$type<Workflow>().notNull(),
    // path from `.halinka/config.yml`; `files` has its text when the base commit has it
    devcontainer: text(),
    setupNetwork: jsonb().$type<NetworkHosts>().notNull().default([]),
    setupRun: text(),
    setupSecrets: text().array().notNull().default([]),
    setupDocker: boolean().notNull().default(false),
    // copied from `resolved` for `claim`
    runsOn: text().array().notNull().default([]),
    agents: text().array().notNull().default([]),
    createdAt: createdAt(),
  },
  (table) => [
    unique("workflow_snapshots_repo_id_path_content_hash_unique").on(
      table.repoId,
      table.path,
      table.contentHash,
    ),
  ],
);

export type DbWorkflowSnapshot = InferSelectModel<typeof workflowSnapshots>;
