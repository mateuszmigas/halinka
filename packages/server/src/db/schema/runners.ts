import { runnerStates, runnerUpdateRequests } from "@halinka/protocol";
import type { InferSelectModel } from "drizzle-orm";
import { boolean, integer, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { createdAt, sandboxKind, updatedAt } from "./shared";

export const runnerState = pgEnum("runner_state", runnerStates);

export const runnerUpdateRequest = pgEnum("runner_update_request", runnerUpdateRequests);

export const runners = pgTable("runners", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: text().notNull().unique("runners_name_unique"),
  state: runnerState().notNull().default("active"),
  labels: text().array().notNull().default([]),
  // null: every agent
  allowedAgents: text().array(),
  os: text(),
  arch: text(),
  // the capabilities of the last `sync`; null before the first one
  sandboxKind: sandboxKind(),
  // devcontainer runners only
  docker: boolean().notNull().default(false),
  sysbox: boolean().notNull().default(false),
  sshHostKey: text(),
  // worktree runners only
  agentsOnPath: text().array().notNull().default([]),
  version: text(),
  buildId: text(),
  protocolVersion: integer(),
  canUpdate: boolean().notNull().default(false),
  autoUpdate: boolean().notNull().default(false),
  // null: no update requested; the next sync on the build of the server clears it
  updateRequest: runnerUpdateRequest(),
  // the reason of the last failed update, and the build that it did not install
  updateFailure: text(),
  updateFailedBuildId: text(),
  lastSeenAt: timestamp({ withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type DbRunner = InferSelectModel<typeof runners>;
