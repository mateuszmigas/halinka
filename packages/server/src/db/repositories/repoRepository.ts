import { and, asc, eq, isNotNull, isNull, notExists, type SQL, sql } from "drizzle-orm";

import type { Db } from "../client";
import { type DbRepo, repos, workflowRuns } from "../schema";

const notDeleting = isNull(repos.deletingAt);

const onGitHub = sql`${repos.kind} = 'github'`;

export class RepoRepository {
  constructor(private readonly db: Db) {}

  list(): Promise<DbRepo[]> {
    return this.db.select().from(repos).where(notDeleting).orderBy(asc(repos.id));
  }

  findById(id: number): Promise<DbRepo | undefined> {
    return this.findBy(and(eq(repos.id, id), notDeleting));
  }

  findByGitHubRepoId(githubRepoId: number): Promise<DbRepo | undefined> {
    return this.findBy(and(onGitHub, eq(repos.githubRepoId, githubRepoId), notDeleting));
  }

  // Call it in a transaction: the repo stays locked until the transaction ends.
  async lockById(id: number, strength: "share" | "update"): Promise<DbRepo | undefined> {
    const [repo] = await this.db.select().from(repos).where(eq(repos.id, id)).for(strength);
    return repo;
  }

  async setGitHubRepo(id: number, githubRepoId: number | null): Promise<DbRepo | undefined> {
    const [repo] = await this.db
      .update(repos)
      .set({ githubRepoId })
      .where(eq(repos.id, id))
      .returning();
    return repo;
  }

  async markDeleting(id: number) {
    await this.db.update(repos).set({ deletingAt: new Date() }).where(eq(repos.id, id));
  }

  async deleteIfGone(id: number): Promise<DbRepo | undefined> {
    const [deleted] = await this.db
      .delete(repos)
      .where(and(eq(repos.id, id), this.isGone()))
      .returning();
    return deleted;
  }

  // A race of two reports can leave a deleting repo without runs.
  async deleteGone() {
    await this.db.delete(repos).where(this.isGone());
  }

  async register(repo: { name: string; path: string; runnerId: number }): Promise<DbRepo> {
    const [created] = await this.db
      .insert(repos)
      .values(repo)
      .onConflictDoNothing({ target: [repos.runnerId, repos.path] })
      .returning();
    const registered =
      created ??
      (await this.findBy(and(eq(repos.runnerId, repo.runnerId), eq(repos.path, repo.path))));
    if (!registered) throw new Error(`The repo ${repo.path} was not registered`);
    return registered;
  }

  async createGitHub(repo: { name: string; githubRepoId: number }): Promise<DbRepo> {
    const [created] = await this.db
      .insert(repos)
      .values({ ...repo, kind: "github" })
      .onConflictDoNothing({ target: repos.githubRepoId, where: onGitHub })
      .returning();
    const added =
      created ?? (await this.findBy(and(onGitHub, eq(repos.githubRepoId, repo.githubRepoId))));
    if (!added) throw new Error(`The GitHub repo ${repo.githubRepoId} was not added`);
    return added;
  }

  private async findBy(where: SQL | undefined) {
    const [repo] = await this.db.select().from(repos).where(where);
    return repo;
  }

  private isGone() {
    const runsOfRepo = this.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(eq(workflowRuns.repoId, repos.id));
    return and(isNotNull(repos.deletingAt), notExists(runsOfRepo));
  }
}
