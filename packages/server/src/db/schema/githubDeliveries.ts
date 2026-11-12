import type { InferSelectModel } from "drizzle-orm";
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const gitHubDeliveries = pgTable("github_deliveries", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  deliveryId: text().notNull().unique("github_deliveries_delivery_id_unique"),
  event: text().notNull(),
  // null: the work has not finished
  result: text(),
  startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export type DbGitHubDelivery = InferSelectModel<typeof gitHubDeliveries>;
