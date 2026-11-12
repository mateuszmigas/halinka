import { and, eq } from "drizzle-orm";

import type { Db } from "../client";
import { type DbRunnerKeyState, runnerKeys } from "../schema";

export class RunnerKeyRepository {
  constructor(private readonly db: Db) {}

  async create(runnerId: number, publicKey: string, state: DbRunnerKeyState) {
    await this.db.insert(runnerKeys).values({ runnerId, publicKey, state });
  }

  // Call it in a transaction.
  async replacePending(runnerId: number, publicKey: string) {
    await this.db
      .update(runnerKeys)
      .set({ state: "retired" })
      .where(and(eq(runnerKeys.runnerId, runnerId), eq(runnerKeys.state, "pending")));
    await this.create(runnerId, publicKey, "pending");
  }

  // Call it in a transaction, after `RunnerRepository.lockById`. False when the key is not pending.
  async promote(runnerId: number, publicKey: string) {
    const [pending] = await this.db
      .select({ id: runnerKeys.id })
      .from(runnerKeys)
      .where(
        and(
          eq(runnerKeys.runnerId, runnerId),
          eq(runnerKeys.publicKey, publicKey),
          eq(runnerKeys.state, "pending"),
        ),
      );
    if (!pending) return false;
    await this.db
      .update(runnerKeys)
      .set({ state: "retired" })
      .where(and(eq(runnerKeys.runnerId, runnerId), eq(runnerKeys.state, "current")));
    await this.db.update(runnerKeys).set({ state: "current" }).where(eq(runnerKeys.id, pending.id));
    return true;
  }
}
