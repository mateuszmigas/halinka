import { and, asc, eq } from "drizzle-orm";

import type { Db } from "../client";
import { agentCredentials, type DbAgentCredential } from "../schema";
import { ownedBy } from "./ownedBy";

type NewAgentCredential = Pick<DbAgentCredential, "preset" | "variable" | "memberId" | "sealed">;

export class AgentCredentialRepository {
  constructor(private readonly db: Db) {}

  list(memberId: number | null): Promise<DbAgentCredential[]> {
    return this.db
      .select()
      .from(agentCredentials)
      .where(ownedBy(agentCredentials.memberId, memberId))
      .orderBy(asc(agentCredentials.id));
  }

  listByPreset(preset: string, memberId: number | null): Promise<DbAgentCredential[]> {
    return this.db
      .select()
      .from(agentCredentials)
      .where(and(eq(agentCredentials.preset, preset), ownedBy(agentCredentials.memberId, memberId)))
      .orderBy(asc(agentCredentials.id));
  }

  async save(values: NewAgentCredential) {
    await this.db
      .insert(agentCredentials)
      .values(values)
      .onConflictDoUpdate({
        target: [agentCredentials.preset, agentCredentials.variable, agentCredentials.memberId],
        set: { sealed: values.sealed },
      });
  }

  async delete(preset: string, variable: string, memberId: number | null) {
    await this.db
      .delete(agentCredentials)
      .where(
        and(
          eq(agentCredentials.preset, preset),
          eq(agentCredentials.variable, variable),
          ownedBy(agentCredentials.memberId, memberId),
        ),
      );
  }
}
