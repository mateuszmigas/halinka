import { sql } from "drizzle-orm";

import type { Db } from "../client";
import { type DbServerSetting, serverSettings } from "../schema";

export type ServerSettingChanges = { isUpdateCheckOn?: boolean };

export class ServerSettingRepository {
  constructor(private readonly db: Db) {}

  async findOrCreate(): Promise<DbServerSetting> {
    await this.db.insert(serverSettings).values({}).onConflictDoNothing();
    const [row] = await this.db.select().from(serverSettings);
    if (!row) throw new Error("The database has no server settings");
    return row;
  }

  async update({ isUpdateCheckOn }: ServerSettingChanges): Promise<DbServerSetting> {
    const [row] = await this.db
      .update(serverSettings)
      .set({
        updatedAt: sql`now()`,
        ...(isUpdateCheckOn !== undefined && { updateCheck: isUpdateCheckOn }),
      })
      .returning();
    if (!row) throw new Error("The database has no server settings");
    return row;
  }
}
