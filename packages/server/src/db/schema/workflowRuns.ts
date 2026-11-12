import {
  leasedRunStatuses,
  runResults,
  runStatuses,
  type SandboxAttach,
  sandboxSpecs,
  sandboxStates,
} from "@halinka/protocol";
import type { Inputs } from "@halinka/workflow";
import { type InferSelectModel, inArray, notInArray, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  type PgColumn,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { members } from "./members";
import { repos } from "./repos";
import { runners } from "./runners";
import { createdAt, sandboxKind, updatedAt } from "./shared";
import { workflowSnapshots } from "./workflowSnapshots";

export const workflowRunStatus = pgEnum("workflow_run_status", runStatuses);

export const sandboxSpec = pgEnum("sandbox_spec", sandboxSpecs);

export const sandboxState = pgEnum("sandbox_state", sandboxStates);

// the predicate of `workflow_runs_active_branch_idx`, also for `on conflict`
export const isActiveRun = (status: PgColumn) => notInArray(status, [...runResults]).inlineParams();

// the predicate of `workflow_runs_sandbox_behind_idx`: the engine that holds a run owns its sandbox
export const isSandboxBehind = (table: {
  status: PgColumn;
  sandbox: PgColumn;
  sandboxGeneration: PgColumn;
  sandboxObservedGeneration: PgColumn;
}) =>
  sql`${table.sandbox} is not null and ${table.sandboxObservedGeneration} is distinct from ${table.sandboxGeneration} and ${notInArray(table.status, [...leasedRunStatuses]).inlineParams()}`;

// the predicate of `workflow_runs_sandbox_kept_idx`
export const isSandboxKept = (sandbox: PgColumn) => sql`${sandbox} <> 'destroyed'`;

export type DbWorkflowRunStatus = (typeof workflowRunStatus.enumValues)[number];

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    repoId: integer()
      .notNull()
      .references(() => repos.id),
    // null: a `github` run before its first claim
    runnerId: integer().references(() => runners.id),
    workflowSnapshotId: integer()
      .notNull()
      .references(() => workflowSnapshots.id),
    // null: no login, or the person left
    authorId: integer().references(() => members.id, { onDelete: "set null" }),
    status: workflowRunStatus().notNull().default("queued"),
    inputs: jsonb().$type<Inputs>().notNull().default({}),
    untrusted: boolean().notNull().default(false),
    testRun: boolean().notNull().default(false),
    branchName: text(),
    // null: a test run, or a workflow with no group
    concurrencyGroup: text(),
    branch: text()
      .notNull()
      .generatedAlwaysAs(sql`coalesce(branch_name, 'halinka/run-' || id::text)`),
    createdBranch: boolean().notNull().default(false),
    // the first commit of the code: the head of a pull request, else `definitionSha`
    baseSha: text().notNull(),
    // of the workflow, the devcontainer and the build: the default branch when the run was made
    definitionSha: text().notNull(),
    pullRequestNumber: integer(),
    leaseToken: text(),
    leaseUntil: timestamp({ withTimezone: true }),
    // the runner process's `instanceId` from `sync`
    leaseHolder: text(),
    cancelRequestedAt: timestamp({ withTimezone: true }),
    // why the run failed outside its steps
    error: text(),
    // null until the first claim
    sandbox: sandboxSpec(),
    sandboxKind: sandboxKind(),
    // the TTL counts from here: the end of the run, or a start of its sandbox
    sandboxKeptAt: timestamp({ withTimezone: true }),
    sandboxGeneration: integer().notNull().default(0),
    sandboxObserved: sandboxState(),
    sandboxObservedGeneration: integer(),
    sandboxAttach: jsonb().$type<SandboxAttach>(),
    // a person started the container since the last finished attempt
    workspaceOpened: boolean().notNull().default(false),
    sandboxError: text(),
    // the row is deleted when the runner reports the sandbox removed
    deletingAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("workflow_runs_status_idx").on(table.status),
    index("workflow_runs_repo_id_idx").on(table.repoId),
    index("workflow_runs_runner_id_idx").on(table.runnerId),
    index("workflow_runs_author_id_idx").on(table.authorId),
    index("workflow_runs_created_at_idx").on(table.createdAt),
    index("workflow_runs_concurrency_group_idx")
      .on(table.repoId, table.concurrencyGroup)
      .where(
        sql`${table.concurrencyGroup} is not null and ${inArray(table.status, ["queued", ...leasedRunStatuses]).inlineParams()}`,
      ),
    index("workflow_runs_queued_idx")
      .on(table.id)
      .where(sql`${table.status} = 'queued'`),
    index("workflow_runs_sandbox_kept_idx")
      .on(table.sandboxKeptAt)
      .where(isSandboxKept(table.sandbox)),
    index("workflow_runs_sandbox_behind_idx").on(table.id).where(isSandboxBehind(table)),
    uniqueIndex("workflow_runs_active_branch_idx")
      .on(table.repoId, table.branch)
      .where(isActiveRun(table.status)),
  ],
);

export type DbWorkflowRun = InferSelectModel<typeof workflowRuns>;

// A test run and code of a pull request get no setup secrets.
export const getsNoSetupSecrets = ({
  testRun,
  pullRequestNumber,
}: {
  testRun: boolean;
  pullRequestNumber: number | null;
}) => testRun || pullRequestNumber !== null;

export const skipsSetup = (run: {
  testRun: boolean;
  pullRequestNumber: number | null;
  setupSecrets: string[];
}) => getsNoSetupSecrets(run) && run.setupSecrets.length > 0;
