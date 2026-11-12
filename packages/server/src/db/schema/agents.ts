import type { InferSelectModel } from "drizzle-orm";
import { boolean, integer, pgTable, text } from "drizzle-orm/pg-core";

import { createdAt, updatedAt } from "./shared";

// No row: the agent is enabled, at the version of its preset, with its own default model.
export const agents = pgTable("agents", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  preset: text().notNull().unique("agents_preset_unique"),
  enabled: boolean().notNull().default(true),
  version: text(),
  model: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type DbAgent = InferSelectModel<typeof agents>;
