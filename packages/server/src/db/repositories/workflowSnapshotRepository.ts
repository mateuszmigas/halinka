import { hashOf } from "@halinka/utils/hash";
import type { NetworkHosts, Workflow } from "@halinka/workflow";
import { and, eq } from "drizzle-orm";

import type { Db } from "../client";
import { type DbWorkflowSnapshot, workflowSnapshots } from "../schema";

type NewWorkflowSnapshot = {
  repoId: number;
  path: string;
  files: Record<string, string>;
  resolved: Workflow;
  devcontainer?: string;
  setupNetwork?: NetworkHosts;
  setupRun?: string;
  setupSecrets?: string[];
  setupDocker?: boolean;
  runsOn: string[];
  agents: string[];
};

const contentHashOf = (files: Record<string, string>) =>
  hashOf(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))));

export class WorkflowSnapshotRepository {
  constructor(private readonly db: Db) {}

  async deleteByRepo(repoId: number) {
    await this.db.delete(workflowSnapshots).where(eq(workflowSnapshots.repoId, repoId));
  }

  async findOrCreate(snapshot: NewWorkflowSnapshot): Promise<DbWorkflowSnapshot> {
    const contentHash = contentHashOf(snapshot.files);
    const [created] = await this.db
      .insert(workflowSnapshots)
      .values({ ...snapshot, contentHash })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    const [existing] = await this.db
      .select()
      .from(workflowSnapshots)
      .where(
        and(
          eq(workflowSnapshots.repoId, snapshot.repoId),
          eq(workflowSnapshots.path, snapshot.path),
          eq(workflowSnapshots.contentHash, contentHash),
        ),
      );
    if (!existing) throw new Error(`The snapshot of ${snapshot.path} was not stored`);
    return existing;
  }
}
