import { describe, expect, it } from "vitest";

import { accounts, members, sessions, users } from "../db/schema";
import {
  createTestServer,
  type GitHubUser,
  hubot,
  logIn as logInAs,
  octo,
  setUpTestDb,
  testApiUrl,
} from "../testing";

const testDb = setUpTestDb();

const setUp = async () => {
  const { app } = await createTestServer(testDb(), { hasAuth: true });
  return { app, logIn: (user: GitHubUser) => logInAs(app, testApiUrl, user) };
};

const addMember = () =>
  testDb().insert(members).values({ githubId: "2002", login: "hubot", role: "member" });

describe("login", () => {
  it("makes the configured GitHub user the first Admin", async () => {
    const { logIn } = await setUp();

    await logIn(octo);

    expect(await testDb().select().from(members)).toMatchObject([
      { githubId: "1001", role: "admin" },
    ]);
  });

  it("finds the configured GitHub user in any letter case", async () => {
    const { logIn } = await setUp();

    await logIn({ ...octo, login: "OCTO" });

    expect(await testDb().select().from(members)).toMatchObject([{ role: "admin" }]);
  });

  it("keeps the GitHub id on the user", async () => {
    const { logIn } = await setUp();

    await logIn(octo);

    expect(await testDb().select().from(users)).toMatchObject([{ githubId: "1001" }]);
  });

  it("makes a session", async () => {
    const { logIn } = await setUp();

    await logIn(octo);

    expect(await testDb().select().from(sessions)).toHaveLength(1);
  });

  it("logs in again with the same user", async () => {
    const { logIn } = await setUp();
    await logIn(octo);

    await logIn(octo);

    expect(await testDb().select().from(users)).toHaveLength(1);
  });

  it("refuses a GitHub user that no Admin added", async () => {
    const { logIn } = await setUp();
    await logIn(octo);

    const { answer } = await logIn(hubot);

    expect(answer.headers.get("location")).toBe("/runs?login=refused");
  });

  it("logs in a GitHub user that an Admin added", async () => {
    const { logIn } = await setUp();
    await addMember();

    const { cookie } = await logIn(hubot);

    expect(cookie).toContain("session_token");
  });

  it("refuses another GitHub user with the configured login once an Admin exists", async () => {
    const { logIn } = await setUp();
    await logIn(octo);

    const { answer } = await logIn({ ...octo, id: 3003, email: "new@example.com" });

    expect(answer.headers.get("location")).toBe("/runs?login=refused");
  });

  it("gives no session to a member with the email of another user", async () => {
    const { logIn } = await setUp();
    await logIn(octo);
    await addMember();

    const { cookie } = await logIn({ ...hubot, email: octo.email });

    expect(cookie).toBe("");
  });

  it("does not keep the token of GitHub at the first login", async () => {
    const { logIn } = await setUp();

    await logIn(octo);

    expect(await testDb().select().from(accounts)).toMatchObject([
      { accountId: "1001", accessToken: null, refreshToken: null, idToken: null },
    ]);
  });

  it("does not keep the token of GitHub at a later login", async () => {
    const { logIn } = await setUp();
    await logIn(octo);

    await logIn(octo);

    expect(await testDb().select().from(accounts)).toMatchObject([{ accessToken: null }]);
  });

  it("has no route that changes a user", async () => {
    const { app } = await setUp();

    const answer = await app.request(`${testApiUrl}/api/auth/update-user`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubId: "1001" }),
    });

    expect(answer.status).toBe(404);
  });
});
