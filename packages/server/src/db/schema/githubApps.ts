import { type InferSelectModel, sql } from "drizzle-orm";
import { bigint, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { createdAt } from "./shared";

export const gitHubApps = pgTable(
  "github_apps",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    githubId: bigint({ mode: "number" }).notNull(),
    slug: text().notNull(),
    ownerLogin: text().notNull(),
    sealedPrivateKey: text().notNull(),
    // null: an App without a webhook
    sealedWebhookSecret: text(),
    createdAt: createdAt(),
  },
  () => [uniqueIndex("github_apps_one_row_idx").on(sql`(true)`)],
);

export type DbGitHubApp = InferSelectModel<typeof gitHubApps>;
