import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { type Context, Hono } from "hono";

import type { Db } from "../db/client";
import { accounts, type DbMember, sessions, users, verifications } from "../db/schema";
import type { Services } from "../services";
import type { MemberService } from "../services/memberService";
import type { AuthConfig } from "./config";

// No `memberId`: the team, on a server without a login.
export type ApiUser = Pick<DbMember, "login" | "role"> & { memberId?: number; cliLoginId?: number };

const localAdmin: ApiUser = { login: "local", role: "admin" };

const withoutTokens = async <T>(account: T) => ({
  data: { ...account, accessToken: null, refreshToken: null, idToken: null },
});

export const createAuth = (db: Db, members: MemberService, config: AuthConfig) =>
  betterAuth({
    baseURL: config.publicUrl,
    secret: config.secret,
    telemetry: { enabled: false },
    // In production it counts all clients behind a proxy as one. `addressRateLimit` limits these routes.
    rateLimit: { enabled: false },
    database: drizzleAdapter(db, {
      provider: "pg",
      usePlural: true,
      schema: { users, sessions, accounts, verifications },
    }),
    advanced: { cookiePrefix: "halinka", database: { generateId: "serial" } },
    onAPIError: { errorURL: `${config.publicUrl}/runs?login=failed` },
    socialProviders: {
      github: {
        clientId: config.github.clientId,
        clientSecret: config.github.clientSecret,
        mapProfileToUser: async ({ id, login }) => {
          const githubId = String(id);
          if (!(await members.admit({ githubId, login }, config.firstAdminLogin))) {
            throw new APIError("FORBIDDEN", {
              message: `An Admin of this server must add the GitHub user ${login} first`,
            });
          }
          return { githubId };
        },
      },
    },
    // A person with the email of another user must not get the rights of that user.
    account: { accountLinking: { enabled: false } },
    // `input` only lets the value of `mapProfileToUser` pass: no route of `authRoutes` changes a user.
    user: { additionalFields: { githubId: { type: "string", input: true } } },
    databaseHooks: {
      account: {
        create: { before: withoutTokens },
        update: { before: withoutTokens },
      },
    },
  });

export type Auth = ReturnType<typeof createAuth>;

const findMemberOfSession = async (auth: Auth, members: MemberService, headers: Headers) => {
  const session = await auth.api.getSession({ headers });
  return session ? members.findByGitHubId(session.user.githubId) : undefined;
};

const apiUserOf = ({ id, login, role }: DbMember, cliLoginId?: number): ApiUser => ({
  memberId: id,
  login,
  role,
  cliLoginId,
});

export const findApiUser = async (
  auth: Auth | undefined,
  services: Services,
  headers: Headers,
): Promise<ApiUser | undefined> => {
  if (!auth) return localAdmin;
  const token = /^Bearer (.+)$/.exec(headers.get("authorization") ?? "")?.[1];
  if (token) {
    const found = await services.cliLogin.findByToken(token);
    return found ? apiUserOf(found.member, found.id) : undefined;
  }
  const member = await findMemberOfSession(auth, services.member, headers);
  return member ? apiUserOf(member) : undefined;
};

export const authRoutes = (auth: Auth) => {
  const handle = (c: Context) => auth.handler(c.req.raw);
  return new Hono()
    .post("/sign-in/social", handle)
    .get("/callback/github", async (c) => {
      const answer = await handle(c);
      return answer.status === 403 ? c.redirect("/runs?login=refused") : answer;
    })
    .get("/get-session", handle)
    .post("/sign-out", handle);
};
