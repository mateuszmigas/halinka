import type { Db } from "../db/client";
import { inTransaction, type Repositories } from "../db/repositories";
import type { DbMember, DbMemberRole } from "../db/schema";
import { findUser } from "../githubApi";
import { ServiceError } from "./serviceError";

const findGitHubUser = async (login: string) => {
  const user = await findUser(login);
  if (!user) throw new ServiceError("BAD_REQUEST", `There is no GitHub user ${login}`);
  if (user.type !== "User") throw new ServiceError("BAD_REQUEST", `${login} is not a GitHub user`);
  return user;
};

export class MemberService {
  constructor(
    private readonly db: Db,
    private readonly repositories: Repositories,
  ) {}

  list() {
    return this.repositories.member.list();
  }

  findByGitHubId(githubId: string) {
    return this.repositories.member.findByGitHubId(githubId);
  }

  // The configured name gives only the first Admin: later it can pass to another person.
  async admit({ githubId, login }: Pick<DbMember, "githubId" | "login">, firstAdminLogin: string) {
    const { member } = this.repositories;
    if (login.toLowerCase() === firstAdminLogin.toLowerCase() && !(await member.hasAdmin())) {
      await member.create({ githubId, login, role: "admin" });
      return true;
    }
    return (await member.findByGitHubId(githubId)) !== undefined;
  }

  async create(login: string, role: DbMemberRole) {
    const user = await findGitHubUser(login);
    const added = await this.repositories.member.create({
      githubId: String(user.id),
      login: user.login,
      role,
    });
    if (!added) throw new ServiceError("CONFLICT", `${user.login} is a member already`);
    return added;
  }

  async delete(id: number) {
    await inTransaction(this.db, async ({ member, user }) => {
      const admins = await member.lockAdmins();
      const found = await member.findById(id);
      if (!found) throw new ServiceError("NOT_FOUND", `There is no member ${id}`);
      if (found.role === "admin" && admins.length === 1) {
        throw new ServiceError("CONFLICT", "Add another Admin before you remove the last one");
      }
      await user.deleteByGitHubId(found.githubId);
      await member.delete(id);
    });
    return { id };
  }
}
