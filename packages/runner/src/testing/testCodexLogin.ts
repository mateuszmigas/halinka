import type { CodexLogin } from "../codexLogin";

export const testToken = (claims: object) =>
  [{ alg: "RS256" }, claims]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .concat("signature")
    .join(".");

export const testAccount = {
  chatgpt_account_id: "account-1",
  chatgpt_plan_type: "pro",
  chatgpt_user_id: "user-1",
};

export const testIdToken = (account = testAccount) =>
  testToken({
    email: "user@example.com",
    "https://api.openai.com/auth": { ...account, groups: ["group-1"] },
  });

export const testCodexLogin = (
  accessTokenId = "1",
  jwtTimes: { iat?: number; exp: number } = { exp: 1_800_000_000 },
): CodexLogin => ({
  idToken: testIdToken(),
  accessToken: testToken({ ...jwtTimes, jti: `access-${accessTokenId}` }),
  refreshToken: `refresh-token-${accessTokenId}`,
  accountId: "account-1",
});

export const claimsOf = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
