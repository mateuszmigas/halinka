import { asc, eq } from "drizzle-orm";

import type { Db } from "../client";
import { type DbMember, members } from "../schema";

type NewMember = Pick<DbMember, "githubId" | "login" | "role">;

export class MemberRepository {
  constructor(private readonly db: Db) {}

  list(): Promise<DbMember[]> {
    return this.db.select().from(members).orderBy(asc(members.id));
  }

  async findById(id: number): Promise<DbMember | undefined> {
    const [member] = await this.db.select().from(members).where(eq(members.id, id));
    return member;
  }

  async findByGitHubId(githubId: string): Promise<DbMember | undefined> {
    const [member] = await this.db.select().from(members).where(eq(members.githubId, githubId));
    return member;
  }

  async hasAdmin() {
    const [admin] = await this.db
      .select({ id: members.id })
      .from(members)
      .where(eq(members.role, "admin"))
      .limit(1);
    return admin !== undefined;
  }

  async create(values: NewMember): Promise<DbMember | undefined> {
    const [added] = await this.db.insert(members).values(values).onConflictDoNothing().returning();
    return added;
  }

  // Call it in a transaction: the Admins stay locked until the transaction ends.
  lockAdmins() {
    return this.db
      .select({ id: members.id })
      .from(members)
      .where(eq(members.role, "admin"))
      .for("update");
  }

  async delete(id: number) {
    await this.db.delete(members).where(eq(members.id, id));
  }
}
