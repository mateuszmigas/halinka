import { and, asc, eq, gt, isNotNull, isNull, lte, sql } from "drizzle-orm";

import type { Db } from "../client";
import { cliLogins, type DbCliLogin, type DbMember, members } from "../schema";

const notExpired = gt(cliLogins.expiresAt, sql`now()`);

const expiryIn = (minutes: number) => sql`now() + make_interval(mins => ${minutes})`;

export class CliLoginRepository {
  constructor(private readonly db: Db) {}

  async createRequest(userCode: string, deviceCodeHash: string, minutes: number) {
    const [created] = await this.db
      .insert(cliLogins)
      .values({ userCode, deviceCodeHash, expiresAt: expiryIn(minutes) })
      .returning({ expiresAt: cliLogins.expiresAt });
    if (!created) throw new Error("The CLI login was not stored");
    return created;
  }

  async approve(userCode: string, memberId: number): Promise<DbCliLogin | undefined> {
    const [approved] = await this.db
      .update(cliLogins)
      .set({ memberId })
      .where(and(eq(cliLogins.userCode, userCode), isNull(cliLogins.memberId), notExpired))
      .returning();
    return approved;
  }

  async findRequest(deviceCodeHash: string): Promise<DbCliLogin | undefined> {
    const [request] = await this.db
      .select()
      .from(cliLogins)
      .where(and(eq(cliLogins.deviceCodeHash, deviceCodeHash), notExpired));
    return request;
  }

  // A request is open until its exchange clears the device code.
  async exchange(id: number, tokenHash: string, minutes: number) {
    const [exchanged] = await this.db
      .update(cliLogins)
      .set({ tokenHash, deviceCodeHash: null, userCode: null, expiresAt: expiryIn(minutes) })
      .where(and(eq(cliLogins.id, id), isNotNull(cliLogins.deviceCodeHash), notExpired))
      .returning({ id: cliLogins.id });
    return exchanged;
  }

  async findByToken(tokenHash: string): Promise<{ id: number; member: DbMember } | undefined> {
    const [found] = await this.db
      .select({ id: cliLogins.id, member: members })
      .from(cliLogins)
      .innerJoin(members, eq(members.id, cliLogins.memberId))
      .where(and(eq(cliLogins.tokenHash, tokenHash), notExpired));
    return found;
  }

  listTokensByMember(memberId: number) {
    return this.db
      .select({
        id: cliLogins.id,
        createdAt: cliLogins.createdAt,
        expiresAt: cliLogins.expiresAt,
      })
      .from(cliLogins)
      .where(and(eq(cliLogins.memberId, memberId), isNotNull(cliLogins.tokenHash), notExpired))
      .orderBy(asc(cliLogins.id));
  }

  async deleteToken(id: number, memberId: number) {
    const [deleted] = await this.db
      .delete(cliLogins)
      .where(
        and(eq(cliLogins.id, id), eq(cliLogins.memberId, memberId), isNotNull(cliLogins.tokenHash)),
      )
      .returning({ id: cliLogins.id });
    return deleted;
  }

  async deleteExpired() {
    await this.db.delete(cliLogins).where(lte(cliLogins.expiresAt, sql`now()`));
  }
}
