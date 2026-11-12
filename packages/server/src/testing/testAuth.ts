import { vi } from "vitest";

import type { AuthConfig } from "../auth/config";

export const testAuthConfig = (publicUrl: string): AuthConfig => ({
  publicUrl,
  secret: "s".repeat(32),
  github: { clientId: "client", clientSecret: "secret" },
  firstAdminLogin: "octo",
});

export const octo = {
  id: 1001,
  login: "octo",
  name: "Octo",
  email: "octo@example.com",
  type: "User",
};

export const hubot = {
  id: 2002,
  login: "hubot",
  name: "Hubot",
  email: "hubot@example.com",
  type: "User",
};

export type GitHubUser = typeof octo;

export const fakeGitHub = (loggingIn: GitHubUser, known: GitHubUser[] = [octo, hubot]) =>
  vi.stubGlobal("fetch", async (input: Request | URL | string) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/login/oauth/access_token")) {
      return Response.json({ access_token: "gho_token", token_type: "bearer" });
    }
    if (url.endsWith("/user/emails")) {
      return Response.json([{ email: loggingIn.email, primary: true, verified: true }]);
    }
    if (url.endsWith("/user")) return Response.json(loggingIn);
    const found = known.find(({ login }) => url.endsWith(`/users/${login}`));
    return found ? Response.json(found) : new Response(null, { status: 404 });
  });

type Requests = { request: (url: string, init?: RequestInit) => Response | Promise<Response> };

const cookiePair = (cookie: string) => cookie.split(";")[0];

export const logIn = async (app: Requests, origin: string, user: GitHubUser) => {
  fakeGitHub(user);
  const start = await app.request(`${origin}/api/auth/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "github", callbackURL: "/" }),
  });
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  const answer = await app.request(`${origin}/api/auth/callback/github?code=code&state=${state}`, {
    headers: { cookie: start.headers.getSetCookie().map(cookiePair).join("; ") },
  });
  const cookie = answer.headers
    .getSetCookie()
    .filter((value) => value.includes("session_token"))
    .map(cookiePair)
    .join("; ");
  return { answer, cookie };
};
