import { and, asc, eq } from "drizzle-orm";

import type { Db } from "../client";
import { type DbRepoSecret, repoSecrets } from "../schema";

type NewRepoSecret = Pick<DbRepoSecret, "repoId" | "name" | "sealed">;

export class RepoSecretRepository {
  constructor(private readonly db: Db) {}

  listByRepo(repoId: number): Promise<DbRepoSecret[]> {
    return this.db
      .select()
      .from(repoSecrets)
      .where(eq(repoSecrets.repoId, repoId))
      .orderBy(asc(repoSecrets.name));
  }

  async save(values: NewRepoSecret) {
    await this.db
      .insert(repoSecrets)
      .values(values)
      .onConflictDoUpdate({
        target: [repoSecrets.repoId, repoSecrets.name],
        set: { sealed: values.sealed, updatedAt: new Date() },
      });
  }

  async delete(repoId: number, name: string) {
    await this.db
      .delete(repoSecrets)
      .where(and(eq(repoSecrets.repoId, repoId), eq(repoSecrets.name, name)));
  }

  async deleteByRepo(repoId: number) {
    await this.db.delete(repoSecrets).where(eq(repoSecrets.repoId, repoId));
  }
}
