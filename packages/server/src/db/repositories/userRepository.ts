import { eq } from "drizzle-orm";

import type { Db } from "../client";
import { users } from "../schema";

export class UserRepository {
  constructor(private readonly db: Db) {}

  // The sessions of the user go with it.
  async deleteByGitHubId(githubId: string) {
    await this.db.delete(users).where(eq(users.githubId, githubId));
  }
}
