import { asc, eq, notInArray, sql } from "drizzle-orm";

import type { Db } from "../client";
import {
  type DbGitHubApp,
  type DbGitHubInstallation,
  type DbGitHubInstallationRepo,
  gitHubApps,
  gitHubInstallationRepos,
  gitHubInstallations,
} from "../schema";

type NewGitHubApp = Pick<
  DbGitHubApp,
  "githubId" | "slug" | "ownerLogin" | "sealedPrivateKey" | "sealedWebhookSecret"
>;

export type InstallationValues = Pick<DbGitHubInstallation, "githubId" | "accountLogin"> & {
  isSuspended: boolean;
  repos: Pick<DbGitHubInstallationRepo, "githubId" | "owner" | "name">[];
};

export class GitHubAppRepository {
  constructor(private readonly db: Db) {}

  async findCurrent(): Promise<DbGitHubApp | undefined> {
    const [app] = await this.db.select().from(gitHubApps);
    return app;
  }

  // Call it in a transaction: a disconnect waits for its commit.
  async lockCurrent(): Promise<DbGitHubApp | undefined> {
    const [app] = await this.db.select().from(gitHubApps).for("update");
    return app;
  }

  async create(values: NewGitHubApp): Promise<DbGitHubApp | undefined> {
    const [app] = await this.db.insert(gitHubApps).values(values).onConflictDoNothing().returning();
    return app;
  }

  async deleteCurrent(): Promise<DbGitHubApp | undefined> {
    const [app] = await this.db.delete(gitHubApps).returning();
    return app;
  }

  listInstallations(): Promise<DbGitHubInstallation[]> {
    return this.db
      .select()
      .from(gitHubInstallations)
      .orderBy(asc(gitHubInstallations.accountLogin));
  }

  listRepos(): Promise<DbGitHubInstallationRepo[]> {
    return this.db
      .select()
      .from(gitHubInstallationRepos)
      .orderBy(asc(gitHubInstallationRepos.owner), asc(gitHubInstallationRepos.name));
  }

  async findRepo(githubRepoId: number): Promise<DbGitHubInstallationRepo | undefined> {
    const [repo] = await this.db
      .select()
      .from(gitHubInstallationRepos)
      .where(eq(gitHubInstallationRepos.githubId, githubRepoId));
    return repo;
  }

  async findInstallationByRepo(githubRepoId: number): Promise<number | undefined> {
    const [found] = await this.db
      .select({ githubId: gitHubInstallations.githubId })
      .from(gitHubInstallationRepos)
      .innerJoin(
        gitHubInstallations,
        eq(gitHubInstallations.id, gitHubInstallationRepos.installationId),
      )
      .where(eq(gitHubInstallationRepos.githubId, githubRepoId));
    return found?.githubId;
  }

  // Call it in a transaction.
  async saveInstallations(appId: number, installations: InstallationValues[]) {
    const saved =
      installations.length === 0
        ? []
        : await this.db
            .insert(gitHubInstallations)
            .values(
              installations.map(({ githubId, accountLogin, isSuspended }) => ({
                appId,
                githubId,
                accountLogin,
                suspended: isSuspended,
              })),
            )
            .onConflictDoUpdate({
              target: gitHubInstallations.githubId,
              set: {
                accountLogin: sql`excluded.account_login`,
                suspended: sql`excluded.suspended`,
              },
            })
            .returning({ id: gitHubInstallations.id, githubId: gitHubInstallations.githubId });
    const idOf = new Map(saved.map(({ id, githubId }) => [githubId, id]));
    // A repo that moves during the reads comes under two installations.
    const reposById = new Map(
      installations.flatMap(({ githubId, repos }) =>
        repos.map(
          (repo) => [repo.githubId, { ...repo, installationId: idOf.get(githubId)! }] as const,
        ),
      ),
    );
    const repos = [...reposById.values()];
    if (repos.length > 0) {
      await this.db
        .insert(gitHubInstallationRepos)
        .values(repos)
        .onConflictDoUpdate({
          target: gitHubInstallationRepos.githubId,
          set: {
            installationId: sql`excluded.installation_id`,
            owner: sql`excluded.owner`,
            name: sql`excluded.name`,
          },
        });
    }
    await this.db.delete(gitHubInstallationRepos).where(
      notInArray(
        gitHubInstallationRepos.githubId,
        repos.map(({ githubId }) => githubId),
      ),
    );
    // After the repos: this delete also removes the repos of the installation.
    await this.db.delete(gitHubInstallations).where(
      notInArray(
        gitHubInstallations.id,
        saved.map(({ id }) => id),
      ),
    );
  }
}
