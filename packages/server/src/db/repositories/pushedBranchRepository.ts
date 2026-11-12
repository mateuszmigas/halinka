import { and, eq } from "drizzle-orm";

import type { Db } from "../client";
import { type DbPushedBranch, pushedBranches } from "../schema";

const keyOf = (repoId: number, branch: string) =>
  and(eq(pushedBranches.repoId, repoId), eq(pushedBranches.branch, branch));

export type LeaseWrite = { commit: string; expected?: string; pullRequestUrl?: string };

export class PushedBranchRepository {
  constructor(private readonly db: Db) {}

  async find(repoId: number, branch: string): Promise<DbPushedBranch | undefined> {
    const [row] = await this.db.select().from(pushedBranches).where(keyOf(repoId, branch));
    return row;
  }

  // Only over `expected` (undefined: no row yet), so a late push cannot store an older commit.
  async save(
    repoId: number,
    branch: string,
    { commit, expected, pullRequestUrl }: LeaseWrite,
  ): Promise<DbPushedBranch | undefined> {
    const url = pullRequestUrl ? { pullRequestUrl } : {};
    if (expected === undefined) {
      const [row] = await this.db
        .insert(pushedBranches)
        .values({ repoId, branch, commit, ...url })
        .onConflictDoNothing()
        .returning();
      return row;
    }
    const [row] = await this.db
      .update(pushedBranches)
      .set({ commit, ...url })
      .where(and(keyOf(repoId, branch), eq(pushedBranches.commit, expected)))
      .returning();
    return row;
  }
}
