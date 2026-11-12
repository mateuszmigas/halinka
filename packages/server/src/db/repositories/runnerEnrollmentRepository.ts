import { and, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";

import type { Db } from "../client";
import { type DbRunnerEnrollment, runnerEnrollments } from "../schema";
import type { RunnerSettings } from "./runnerRepository";

const enrollmentTtl = sql`now() + interval '15 minutes'`;

const open = and(isNull(runnerEnrollments.usedAt), gt(runnerEnrollments.expiresAt, sql`now()`));

type NewRequest = Pick<DbRunnerEnrollment, "publicKey" | "hostName" | "os" | "arch"> & {
  userCode: string;
};

export class RunnerEnrollmentRepository {
  constructor(private readonly db: Db) {}

  async createToken(
    tokenHash: string,
    values: Partial<RunnerSettings> & { runnerId?: number },
  ): Promise<DbRunnerEnrollment> {
    return this.insert({ tokenHash, ...values });
  }

  async deleteExpired() {
    await this.db.delete(runnerEnrollments).where(lte(runnerEnrollments.expiresAt, sql`now()`));
  }

  // Undefined when the token is unknown, used or expired.
  async useToken(tokenHash: string): Promise<DbRunnerEnrollment | undefined> {
    const [used] = await this.db
      .update(runnerEnrollments)
      .set({ usedAt: sql`now()` })
      .where(and(eq(runnerEnrollments.tokenHash, tokenHash), open))
      .returning();
    return used;
  }

  async createRequest(request: NewRequest): Promise<DbRunnerEnrollment> {
    return this.insert(request);
  }

  async findOpenRequestByPublicKey(publicKey: string): Promise<DbRunnerEnrollment | undefined> {
    const [request] = await this.db
      .select()
      .from(runnerEnrollments)
      .where(and(eq(runnerEnrollments.publicKey, publicKey), open))
      .orderBy(desc(runnerEnrollments.id))
      .limit(1);
    return request;
  }

  async findOpenRequest(userCode: string): Promise<DbRunnerEnrollment | undefined> {
    const [request] = await this.db
      .select()
      .from(runnerEnrollments)
      .where(and(eq(runnerEnrollments.userCode, userCode), open));
    return request;
  }

  // Undefined when the request is unknown, used or expired.
  async useRequest(userCode: string): Promise<DbRunnerEnrollment | undefined> {
    const [used] = await this.db
      .update(runnerEnrollments)
      .set({ usedAt: sql`now()` })
      .where(and(eq(runnerEnrollments.userCode, userCode), open))
      .returning();
    return used;
  }

  async setRunner(id: number, runnerId: number) {
    await this.db.update(runnerEnrollments).set({ runnerId }).where(eq(runnerEnrollments.id, id));
  }

  private async insert(values: Partial<typeof runnerEnrollments.$inferInsert>) {
    const [created] = await this.db
      .insert(runnerEnrollments)
      .values({ ...values, expiresAt: enrollmentTtl })
      .returning();
    if (!created) throw new Error("The enrollment was not stored");
    return created;
  }
}
