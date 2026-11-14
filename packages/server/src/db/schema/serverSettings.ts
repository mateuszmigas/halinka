import { type InferSelectModel, sql } from "drizzle-orm";
import { boolean, integer, pgTable, uniqueIndex } from "drizzle-orm/pg-core";

import { createdAt, updatedAt } from "./shared";

export const serverSettings = pgTable(
  "server_settings",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    updateCheck: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [uniqueIndex("server_settings_one_row_idx").on(sql`(true)`)],
);

export type DbServerSetting = InferSelectModel<typeof serverSettings>;
