import { randomBytes } from "node:crypto";

import type { Db } from "../client";
import { serverIdentities } from "../schema";

export class ServerIdentityRepository {
  constructor(private readonly db: Db) {}

  async findOrCreate() {
    const serverId = randomBytes(6).toString("hex");
    await this.db.insert(serverIdentities).values({ serverId }).onConflictDoNothing();
    const [row] = await this.db.select().from(serverIdentities);
    if (!row) throw new Error("The database has no server id");
    return row.serverId;
  }
}
