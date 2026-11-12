import { sql } from "drizzle-orm";
import { integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { createdAt } from "./shared";

export const serverIdentities = pgTable(
  "server_identities",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    serverId: text().notNull(),
    createdAt: createdAt(),
  },
  () => [uniqueIndex("server_identities_one_row_idx").on(sql`(true)`)],
);
