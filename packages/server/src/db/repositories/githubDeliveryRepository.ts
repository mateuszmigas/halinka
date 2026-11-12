import { and, eq, isNull, lte, sql } from "drizzle-orm";

import type { Db } from "../client";
import { type DbGitHubDelivery, gitHubDeliveries } from "../schema";

const startedBefore = (interval: ReturnType<typeof sql>) =>
  lte(gitHubDeliveries.startedAt, sql`now() - ${interval}`);

export class GitHubDeliveryRepository {
  constructor(private readonly db: Db) {}

  async claim(
    deliveryId: string,
    event: string,
    staleMinutes: number,
  ): Promise<DbGitHubDelivery | undefined> {
    const [claimed] = await this.db
      .insert(gitHubDeliveries)
      .values({ deliveryId, event })
      .onConflictDoUpdate({
        target: gitHubDeliveries.deliveryId,
        set: { startedAt: sql`now()` },
        where: and(
          isNull(gitHubDeliveries.result),
          startedBefore(sql`make_interval(mins => ${staleMinutes})`),
        ),
      })
      .returning();
    return claimed;
  }

  async finish(id: number, result: string) {
    await this.db.update(gitHubDeliveries).set({ result }).where(eq(gitHubDeliveries.id, id));
  }

  async deleteStartedBefore(days: number) {
    await this.db
      .delete(gitHubDeliveries)
      .where(startedBefore(sql`make_interval(days => ${days})`));
  }
}
