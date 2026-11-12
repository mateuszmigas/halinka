import { isDeepStrictEqual } from "node:util";

import {
  type Build,
  leasedRunStatuses,
  type RunnerCapabilities,
  type RunnerUpdateRequest,
} from "@halinka/protocol";
import { and, asc, eq, getTableColumns, inArray, ne, type SQL, sql } from "drizzle-orm";

import type { Db } from "../client";
import {
  type DbRunner,
  type DbRunnerKeyState,
  runnerKeys,
  runners,
  workflowRuns,
  workflowSnapshots,
} from "../schema";
import { disabledAgents, settingsRefusal } from "./dispatchRule";
import { hasAuthority } from "./runnerAuthority";

export type RunnerIdentity = { name: string; publicKey: string };

export type RunnerSettings = Pick<DbRunner, "labels" | "allowedAgents">;

export type RunnerChanges = Partial<RunnerSettings> & {
  state?: "active" | "draining";
  hasAutoUpdate?: boolean;
};

export type NewRunner = Pick<DbRunner, "name"> &
  Partial<RunnerSettings> &
  Partial<Pick<DbRunner, "os" | "arch">>;

// `hasPackage`: the server can serve its build to a runner.
export type ServerBuild = { buildId: string; hasPackage: boolean };

type ReportOptions = {
  capabilities: RunnerCapabilities;
  runnerProtocolVersion: number;
  server: ServerBuild;
};

type BuildReport = { build: Build; runnerProtocolVersion: number };

type UpdateFailure = { buildId: string; reason: string };

export class RunnerRepository {
  constructor(private readonly db: Db) {}

  // Undefined when another runner has the name.
  async create(runner: NewRunner): Promise<DbRunner | undefined> {
    const [created] = await this.db
      .insert(runners)
      .values(runner)
      .onConflictDoNothing({ target: runners.name })
      .returning();
    return created;
  }

  // Call it in a transaction.
  async lockById(id: number) {
    await this.db.select({ id: runners.id }).from(runners).where(eq(runners.id, id)).for("update");
  }

  async findByPublicKey(
    publicKey: string,
  ): Promise<(DbRunner & { keyState: DbRunnerKeyState }) | undefined> {
    const [runner] = await this.db
      .select({ ...getTableColumns(runners), keyState: runnerKeys.state })
      .from(runners)
      .innerJoin(runnerKeys, eq(runnerKeys.runnerId, runners.id))
      .where(eq(runnerKeys.publicKey, publicKey));
    return runner;
  }

  async hasAuthority(id: number, publicKey: string) {
    const [runner] = await this.db
      .select({ id: runners.id })
      .from(runners)
      .where(and(eq(runners.id, id), hasAuthority(id, publicKey)));
    return runner !== undefined;
  }

  // `publicKey`: the current key
  list(): Promise<(DbRunner & { publicKey: string | null; heldRunIds: number[] })[]> {
    return this.db
      .select({
        ...getTableColumns(runners),
        publicKey: runnerKeys.publicKey,
        heldRunIds: sql<
          number[]
        >`array(select ${workflowRuns.id} from ${workflowRuns} where ${workflowRuns.runnerId} = ${runners.id} and ${inArray(workflowRuns.status, [...leasedRunStatuses])} order by ${workflowRuns.id})`,
      })
      .from(runners)
      .leftJoin(
        runnerKeys,
        and(eq(runnerKeys.runnerId, runners.id), eq(runnerKeys.state, "current")),
      )
      .orderBy(asc(runners.id));
  }

  findById(id: number): Promise<DbRunner | undefined> {
    return this.findBy(eq(runners.id, id));
  }

  findByName(name: string): Promise<DbRunner | undefined> {
    return this.findBy(eq(runners.name, name));
  }

  private async findBy(where: SQL) {
    const [runner] = await this.db.select().from(runners).where(where);
    return runner;
  }

  async update(
    id: number,
    { hasAutoUpdate, ...changes }: RunnerChanges,
  ): Promise<DbRunner | undefined> {
    const [updated] = await this.db
      .update(runners)
      .set({ ...changes, ...(hasAutoUpdate !== undefined && { autoUpdate: hasAutoUpdate }) })
      .where(and(eq(runners.id, id), ne(runners.state, "revoked")))
      .returning();
    return updated;
  }

  async revoke(id: number): Promise<DbRunner | undefined> {
    const [revoked] = await this.db
      .update(runners)
      .set({ state: "revoked" })
      .where(eq(runners.id, id))
      .returning();
    return revoked;
  }

  async findSettingsRefusal(id: number, workflowSnapshotId: number) {
    const [found] = await this.db
      .select({
        refusal: settingsRefusal,
        disabledAgents,
        name: runners.name,
        labels: runners.labels,
        allowedAgents: runners.allowedAgents,
      })
      .from(runners)
      .innerJoin(workflowSnapshots, eq(workflowSnapshots.id, workflowSnapshotId))
      .where(eq(runners.id, id));
    const refusal = found?.refusal;
    return found && refusal ? { ...found, refusal } : undefined;
  }

  // A pending key has no authority yet, so the write checks only that the key is not refused.
  async reportBuild(id: number, publicKey: string, { build, runnerProtocolVersion }: BuildReport) {
    await this.db
      .update(runners)
      .set({ version: build.version, buildId: build.id, protocolVersion: runnerProtocolVersion })
      .where(
        and(
          eq(runners.id, id),
          ne(runners.state, "revoked"),
          sql`exists (select 1 from runner_keys k where k.runner_id = ${id} and k.public_key = ${publicKey} and k.state <> 'retired')`,
        ),
      );
  }

  // Call it in a transaction, after `lockById`.
  // Also settles the update request: the process gets it only when it can act on it.
  async report(
    id: number,
    publicKey: string,
    { capabilities, runnerProtocolVersion, server }: ReportOptions,
  ) {
    const { sandboxKind, build } = capabilities;
    const reported = {
      sandboxKind,
      version: build.version,
      buildId: build.id,
      protocolVersion: runnerProtocolVersion,
      canUpdate: capabilities.canUpdate,
      docker: sandboxKind === "devcontainer" && capabilities.hasDocker,
      sysbox: sandboxKind === "devcontainer" && capabilities.hasSysbox,
      sshHostKey: sandboxKind === "devcontainer" ? capabilities.sshHostKey : null,
      agentsOnPath: sandboxKind === "worktree" ? capabilities.agentsOnPath : [],
    };
    const [{ updateRequest: requestBefore, ...before } = { updateRequest: null }] = await this.db
      .select({
        updateRequest: runners.updateRequest,
        sandboxKind: runners.sandboxKind,
        version: runners.version,
        buildId: runners.buildId,
        protocolVersion: runners.protocolVersion,
        canUpdate: runners.canUpdate,
        docker: runners.docker,
        sysbox: runners.sysbox,
        sshHostKey: runners.sshHostKey,
        agentsOnPath: runners.agentsOnPath,
      })
      .from(runners)
      .where(eq(runners.id, id));
    const isOnServerBuild = build.id === server.buildId;
    const canAct = capabilities.canUpdate && server.hasPackage;
    const [row] = await this.db
      .update(runners)
      .set({
        ...reported,
        lastSeenAt: sql`now()`,
        ...(isOnServerBuild && { updateFailure: null, updateFailedBuildId: null }),
        updateRequest:
          isOnServerBuild || !canAct
            ? null
            : sql`case when ${runners.autoUpdate} and ${runners.updateRequest} is null
                and ${runners.updateFailedBuildId} is distinct from ${server.buildId}
                then 'when_idle'::runner_update_request else ${runners.updateRequest} end`,
      })
      .where(and(eq(runners.id, id), hasAuthority(id, publicKey)))
      .returning({ updateRequest: runners.updateRequest });
    const update = row?.updateRequest ?? undefined;
    // A new or ended request changes the wait reason of the queued runs too.
    const isChanged =
      !isDeepStrictEqual(before, reported) || (requestBefore ?? undefined) !== update;
    return { isChanged, update };
  }

  async reportUpdateFailure(id: number, { buildId, reason }: UpdateFailure) {
    await this.db
      .update(runners)
      .set({
        // A repeated report of one build keeps its first reason, the cause of the failure.
        updateFailure: sql`case when ${runners.updateFailedBuildId} = ${buildId} and ${runners.updateFailure} is not null then ${runners.updateFailure} else ${reason} end`,
        updateFailedBuildId: buildId,
        updateRequest: null,
      })
      .where(eq(runners.id, id));
  }

  // `false`: no such runner, a revoked one, one that cannot update, or one on the build of the server.
  async requestUpdate(id: number, request: RunnerUpdateRequest, serverBuildId: string) {
    const [row] = await this.db
      .update(runners)
      .set({ updateRequest: request })
      .where(
        and(
          eq(runners.id, id),
          ne(runners.state, "revoked"),
          eq(runners.canUpdate, true),
          sql`${runners.buildId} is distinct from ${serverBuildId}`,
        ),
      )
      .returning({ id: runners.id });
    return row !== undefined;
  }

  // Also turns auto-update off, which would ask again at the next sync.
  async cancelUpdate(id: number) {
    const [row] = await this.db
      .update(runners)
      .set({ updateRequest: null, autoUpdate: false })
      .where(eq(runners.id, id))
      .returning({ id: runners.id });
    return row !== undefined;
  }
}
