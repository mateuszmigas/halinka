import type { InferSelectModel } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { runners } from "./runners";
import { createdAt } from "./shared";

// A token for scripts (`token_hash`), or a device-flow request of a runner (`user_code`).
export const runnerEnrollments = pgTable(
  "runner_enrollments",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    // sha256 hex of the token
    tokenHash: text().unique("runner_enrollments_token_hash_unique"),
    userCode: text().unique("runner_enrollments_user_code_unique"),
    // of a request: the key and the machine of the runner
    publicKey: text(),
    hostName: text(),
    os: text(),
    arch: text(),
    // of a token: the settings of the runner that it enrolls
    labels: text().array().notNull().default([]),
    allowedAgents: text().array(),
    runnerId: integer().references(() => runners.id),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index("runner_enrollments_public_key_idx").on(table.publicKey)],
);

export type DbRunnerEnrollment = InferSelectModel<typeof runnerEnrollments>;
