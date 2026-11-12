import { and, asc, eq, inArray } from "drizzle-orm";

import type { Db } from "../client";
import { agents, type DbAgent } from "../schema";

export type AgentSettings = { isEnabled?: boolean } & Partial<Pick<DbAgent, "version" | "model">>;

export type AgentSelections = {
  agentVersions: Record<string, string>;
  agentModels: Record<string, string>;
};

export class AgentRepository {
  constructor(private readonly db: Db) {}

  list(): Promise<DbAgent[]> {
    return this.db.select().from(agents).orderBy(asc(agents.id));
  }

  async findSelections(): Promise<AgentSelections> {
    const rows = await this.db
      .select({ preset: agents.preset, version: agents.version, model: agents.model })
      .from(agents);
    const selected = (field: "version" | "model") =>
      Object.fromEntries(
        rows.filter((row) => row[field] !== null).map((row) => [row.preset, row[field]]),
      ) as Record<string, string>;
    return { agentVersions: selected("version"), agentModels: selected("model") };
  }

  async listDisabled(presets: string[]) {
    if (presets.length === 0) return [];
    const rows = await this.db
      .select({ preset: agents.preset })
      .from(agents)
      .where(and(inArray(agents.preset, presets), eq(agents.enabled, false)))
      .orderBy(asc(agents.preset));
    return rows.map(({ preset }) => preset);
  }

  async save(preset: string, { isEnabled, ...settings }: AgentSettings) {
    const row = { ...settings, enabled: isEnabled };
    await this.db
      .insert(agents)
      .values({ preset, ...row })
      .onConflictDoUpdate({ target: agents.preset, set: row });
  }
}
