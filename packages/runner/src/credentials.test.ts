import { agentPresets } from "@halinka/presets";
import { describe, expect, it } from "vitest";

import { type CodexLogin, codexPlaceholder } from "./codexLogin";
import { Credentials } from "./credentials";
import { testAccount, testCodexLogin, testToken } from "./testing";

const withLogin = (login: CodexLogin, env: Record<string, string> = {}) => {
  const credentials = new Credentials(env, { proxyCa: "proxy-ca" });
  credentials.setCodexLogin(login);
  return credentials;
};

const claude = agentPresets["claude-code"];
const stored = [{ variable: "ANTHROPIC_API_KEY", value: "sk-ant-stored-value" }];

describe("Credentials", () => {
  it("gives the proxy a credential of the provider route for each variable of the environment", () => {
    const credentials = new Credentials({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-real" });

    expect(credentials.forProxy()).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: {
        prefix: "/anthropic",
        origin: "https://api.anthropic.com",
        paths: claude.route.paths,
        header: "authorization",
        placeholder: "Bearer sk-ant-oat01-halinka-placeholder",
        value: "Bearer sk-ant-oat01-real",
      },
    });
  });

  it("gives a credential without a scheme its value as it is", () => {
    const credentials = new Credentials({ ANTHROPIC_API_KEY: "sk-ant-api03-real" });

    expect(credentials.forProxy().ANTHROPIC_API_KEY).toMatchObject({
      header: "x-api-key",
      placeholder: "sk-ant-api03-halinka-placeholder",
      value: "sk-ant-api03-real",
    });
  });

  it("lends the plain value of each preset credential", () => {
    const { lent } = new Credentials({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-real" });

    expect(lent.mask("token sk-ant-oat01-real")).toBe("token ***");
  });

  it("skips a credential variable that is empty", () => {
    const credentials = new Credentials({
      CLAUDE_CODE_OAUTH_TOKEN: "",
      ANTHROPIC_API_KEY: "sk-ant-api03-real",
    });

    expect(Object.keys(credentials.forProxy())).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("gives the proxy the ChatGPT login on the login route of the preset", () => {
    const login = testCodexLogin();
    const { token } = codexPlaceholder(login);

    const credentials = withLogin(login);

    expect(credentials.forProxy().CODEX_LOGIN).toEqual({
      prefix: "/chatgpt",
      origin: "https://chatgpt.com",
      paths: agentPresets.codex.login!.route.paths,
      header: "authorization",
      placeholder: `Bearer ${token}`,
      value: `Bearer ${login.accessToken}`,
    });
  });

  it("gives the proxy the Codex login next to the API keys", () => {
    const credentials = withLogin(testCodexLogin(), { CODEX_API_KEY: "sk-real-key" });

    expect(Object.keys(credentials.forProxy())).toEqual(["CODEX_API_KEY", "CODEX_LOGIN"]);
  });

  it("lends each token of the Codex login", () => {
    const login = testCodexLogin();

    const { lent } = withLogin(login);

    expect(lent.mask([login.accessToken, login.refreshToken, login.idToken])).toEqual([
      "***",
      "***",
      "***",
    ]);
  });

  it("keeps the placeholder of a new login of the same account", () => {
    const login = testCodexLogin();
    const credentials = withLogin(login);
    const otherPlan = { ...testAccount, chatgpt_plan_type: "plus" };

    credentials.setCodexLogin({
      ...testCodexLogin("2"),
      idToken: testToken({ "https://api.openai.com/auth": otherPlan }),
    });

    expect(credentials.forProxy().CODEX_LOGIN?.placeholder).toBe(
      `Bearer ${codexPlaceholder(login).token}`,
    );
  });

  it("lends the access token of a new login", () => {
    const credentials = withLogin(testCodexLogin());
    const login = testCodexLogin("2");

    credentials.setCodexLogin(login);

    expect(credentials.forProxy().CODEX_LOGIN?.value).toBe(`Bearer ${login.accessToken}`);
  });

  it("makes a new placeholder for a login of another account", () => {
    const credentials = withLogin(testCodexLogin());
    const account = { ...testAccount, chatgpt_account_id: "account-2" };
    const login = {
      ...testCodexLogin("2"),
      idToken: testToken({ "https://api.openai.com/auth": account }),
      accountId: "account-2",
    };

    credentials.setCodexLogin(login);

    expect(credentials.forProxy().CODEX_LOGIN?.placeholder).toBe(
      `Bearer ${codexPlaceholder(login).token}`,
    );
  });

  it("masks the tokens of a new login and of the earlier login", () => {
    const earlier = testCodexLogin();
    const credentials = withLogin(earlier);
    const login = { ...testCodexLogin("2"), refreshToken: "refresh-token-2" };

    credentials.setCodexLogin(login);

    expect(
      credentials.lent.mask([earlier.accessToken, login.accessToken, login.refreshToken]),
    ).toEqual(["***", "***", "***"]);
  });

  it("masks the access token of an earlier login no more after it expired", () => {
    const earlier = testCodexLogin("1", { exp: Math.floor(Date.now() / 1000) - 60 });
    const credentials = withLogin(earlier);

    credentials.setCodexLogin(testCodexLogin("2"));

    expect(credentials.lent.mask(earlier.accessToken)).toBe(earlier.accessToken);
  });

  it("masks the refresh token of an earlier login that expired", () => {
    const earlier = testCodexLogin("1", { exp: Math.floor(Date.now() / 1000) - 60 });
    const credentials = withLogin(earlier);

    credentials.setCodexLogin(testCodexLogin("2"));

    expect(credentials.lent.mask(earlier.refreshToken)).toBe("***");
  });

  it("masks a token of an expired login that the new login still has", () => {
    const earlier = testCodexLogin("1", { exp: Math.floor(Date.now() / 1000) - 60 });
    const credentials = withLogin(earlier);

    credentials.setCodexLogin(testCodexLogin("2"));

    expect(credentials.lent.mask(earlier.idToken)).toBe("***");
  });

  it("tells that a new refresh token changes the login", () => {
    const credentials = withLogin(testCodexLogin());

    expect(
      credentials.setCodexLogin({ ...testCodexLogin(), refreshToken: "refresh-token-2" }),
    ).toBe(true);
  });

  it("tells that the same login changes nothing", () => {
    const credentials = withLogin(testCodexLogin());

    expect(credentials.setCodexLogin(testCodexLogin())).toBe(false);
  });

  it("gives a stored value only to the proxy of its scope", () => {
    const credentials = new Credentials({});
    const scope = credentials.newScope();

    scope.setStored(claude, stored);

    expect(scope.forProxy().ANTHROPIC_API_KEY?.value).toBe("sk-ant-stored-value");
    expect(credentials.newScope().forProxy()).toEqual({});
  });

  it("gives the proxy the stored value in place of the environment", () => {
    const scope = new Credentials({ ANTHROPIC_API_KEY: "sk-ant-env-value" }).newScope();

    scope.setStored(claude, stored);

    expect(scope.forProxy().ANTHROPIC_API_KEY?.value).toBe("sk-ant-stored-value");
  });

  it("grants only the stored values, not the other variables of the environment", () => {
    const scope = new Credentials({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-real" }).newScope();

    scope.setStored(claude, stored);

    expect(scope.launch(claude).launch?.credentialNames).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("gives another scope the value of the environment", () => {
    const credentials = new Credentials({ ANTHROPIC_API_KEY: "sk-ant-env-value" });

    credentials.newScope().setStored(claude, stored);

    expect(credentials.newScope().forProxy().ANTHROPIC_API_KEY?.value).toBe("sk-ant-env-value");
  });

  it("uses a stored value in place of a login", () => {
    const credentials = withLogin(testCodexLogin());
    const scope = credentials.newScope();

    scope.setStored(agentPresets.codex, [{ variable: "OPENAI_API_KEY", value: "sk-stored-value" }]);

    expect(scope.launch(agentPresets.codex).launch?.credentialNames).toEqual(["OPENAI_API_KEY"]);
    expect(credentials.newScope().launch(agentPresets.codex).launch?.credentialNames).toEqual([
      "CODEX_LOGIN",
    ]);
  });

  it("goes back to the values of the runner when the server stores none", () => {
    const scope = new Credentials({ ANTHROPIC_API_KEY: "sk-ant-env-value" }).newScope();
    scope.setStored(claude, stored);

    scope.setStored(claude, []);

    expect(scope.forProxy().ANTHROPIC_API_KEY?.value).toBe("sk-ant-env-value");
  });

  it("keeps the stored values of the other agent", () => {
    const scope = new Credentials({}).newScope();
    scope.setStored(claude, stored);

    scope.setStored(agentPresets.codex, []);

    expect(scope.forProxy().ANTHROPIC_API_KEY?.value).toBe("sk-ant-stored-value");
  });

  it("masks a stored value for the whole runner", () => {
    const credentials = new Credentials({});

    credentials.newScope().setStored(claude, stored);

    expect(credentials.lent.mask("key sk-ant-stored-value")).toBe("key ***");
  });
});
