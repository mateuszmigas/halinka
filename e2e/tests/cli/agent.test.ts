import { agentPresets } from "@halinka/presets";
import { pathExists } from "@halinka/utils/fs";
import { expect } from "@playwright/test";

import { test } from "../utils";

const token = (claims: object) =>
  [{ alg: "RS256" }, claims]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .concat("signature")
    .join(".");

const tokens = {
  id_token: token({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } }),
  access_token: token({ exp: 1_800_000_000 }),
  refresh_token: "refresh-1",
  account_id: "account-1",
};

test.describe("halinka agent", () => {
  test("saves the ChatGPT login of codex login", async ({ halinka }) => {
    await halinka.installCodexThatLogsIn({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens });

    const cli = halinka.run(["agent", "login", "codex"]);

    await cli.expectExit(0);
    expect(await halinka.readCodexLogin()).toEqual({
      idToken: tokens.id_token,
      accessToken: tokens.access_token,
      refreshToken: "refresh-1",
      accountId: "account-1",
    });
  });

  test("saves the login after the runner process that holds the login lock", async ({
    halinka,
  }) => {
    await halinka.installCodexThatLogsIn({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens });
    const holder = await halinka.holdCodexLoginLock();
    const cli = halinka.run(["agent", "login", "codex"]);
    await cli.expectOutput(`Waiting for the process ${holder.pid}`);

    holder.kill("SIGKILL");

    await cli.expectExit(0);
    expect(await halinka.readCodexLogin()).toMatchObject({ refreshToken: "refresh-1" });
  });

  test("removes the Codex home of a failed login", async ({ halinka }) => {
    await halinka.installCodexThatFails();

    const cli = halinka.run(["agent", "login", "codex"]);

    await cli.expectExit(1);
    await cli.expectOutput("The Codex login did not complete.");
    expect(await pathExists(await halinka.readLastCodexHome())).toBe(false);
  });

  test("changes the agents of the server that runs on this machine", async ({ halinka }) => {
    await halinka.start();

    await halinka.run(["agent", "disable", "codex"]).expectExit(0);
    await halinka.run(["agent", "version", "codex", "1.2.3"]).expectExit(0);

    const list = halinka.run(["agent", "list"]);
    await list.expectOutput("codex  disabled  1.2.3");
    await list.expectExit(0);
  });

  test("goes back to the version of the preset", async ({ halinka }) => {
    await halinka.start();
    await halinka.run(["agent", "version", "codex", "1.2.3"]).expectExit(0);

    await halinka.run(["agent", "version", "codex", "default"]).expectExit(0);

    const list = halinka.run(["agent", "list"]);
    await list.expectOutput(`codex  enabled  ${agentPresets.codex.version}`);
    await list.expectExit(0);
  });

  test("selects the default model of an agent", async ({ halinka }) => {
    await halinka.start();

    await halinka.run(["agent", "model", "codex", "small"]).expectExit(0);

    const list = halinka.run(["agent", "list"]);
    await list.expectOutput(`codex  enabled  ${agentPresets.codex.version}  small`);
    await list.expectExit(0);
  });

  test("goes back to the default model of the agent", async ({ halinka }) => {
    await halinka.start();
    await halinka.run(["agent", "model", "codex", "small"]).expectExit(0);

    await halinka.run(["agent", "model", "codex", "default"]).expectExit(0);

    const list = halinka.run(["agent", "list"]);
    await list.expectOutput(`codex  enabled  ${agentPresets.codex.version}\n`);
    await list.expectExit(0);
  });

  test("stores a key from stdin without printing it", async ({ halinka }) => {
    await halinka.start();
    const key = "sk-ant-api03-made-up-stored-value";

    const stored = halinka.run(["agent", "key", "claude-code", "ANTHROPIC_API_KEY"]).input(key);

    await stored.expectNoOutputAtClose(key);
    await stored.expectExit(0);
    const list = halinka.run(["agent", "list"]);
    await list.expectOutput("ANTHROPIC_API_KEY: set");
    await list.expectExit(0);
  });

  test("removes a stored key", async ({ halinka }) => {
    await halinka.start();
    const key = ["agent", "key", "claude-code", "ANTHROPIC_API_KEY"];
    await halinka.run(key).input("sk-ant-api03-made-up-stored-value").expectExit(0);

    await halinka.run([...key, "--remove"]).expectExit(0);

    const list = halinka.run(["agent", "list"]);
    await list.expectOutput("ANTHROPIC_API_KEY: not set");
    await list.expectExit(0);
  });

  test("names the problem of a key that the server refuses", async ({ halinka }) => {
    await halinka.start();

    const stored = halinka.run(["agent", "key", "claude-code", "ANTHROPIC_API_KEY"]).input("short");

    await stored.expectOutput("Use 8 to 4096 characters");
    await stored.expectExit(1);
  });

  test("refuses an action that it does not know", async ({ halinka }) => {
    const cli = halinka.run(["agent", "add", "codex"]);

    await cli.expectOutput("Give the action and its arguments.");
    await cli.expectExit(1);
  });

  test("tests an agent on a runner", async ({ halinka }) => {
    await halinka.installFakeAgent("claude-code");
    await halinka.start();
    const runner = await halinka.readLocalRunnerName();

    const tested = halinka.run(["agent", "test", "claude-code", "--runner", runner]);

    await tested.expectOutput("The test passed.");
    await tested.expectExit(0);
  });

  test("fails when the test of an agent fails", async ({ halinka }) => {
    await halinka.installBrokenAgent("codex");
    await halinka.start();
    const runner = await halinka.readLocalRunnerName();

    const tested = halinka.run(["agent", "test", "codex", "--runner", runner]);

    await tested.expectOutput("The key is not valid");
    await tested.expectExit(1);
  });

  test("refuses an own key on a server without a login", async ({ halinka }) => {
    await halinka.start();
    const key = ["agent", "key", "claude-code", "ANTHROPIC_API_KEY", "--mine"];

    const stored = halinka.run(key).input("sk-ant-api03-made-up-value");

    await stored.expectOutput("This server has no login");
    await stored.expectExit(1);
  });

  test("refuses the removal of an own key on a server without a login", async ({ halinka }) => {
    await halinka.start();
    const key = ["agent", "key", "claude-code", "ANTHROPIC_API_KEY", "--mine", "--remove"];

    const removed = halinka.run(key);

    await removed.expectOutput("This server has no login");
    await removed.expectExit(1);
  });

  test("refuses a test of an own key on a server without a login", async ({ halinka }) => {
    await halinka.start();
    const runner = await halinka.readLocalRunnerName();

    const tested = halinka.run(["agent", "test", "claude-code", "--runner", runner, "--mine"]);

    await tested.expectOutput("This server has no login");
    await tested.expectExit(1);
  });

  test("refuses --mine on another action", async ({ halinka }) => {
    const cli = halinka.run(["agent", "enable", "codex", "--mine"]);

    await cli.expectOutput("Unknown option '--mine'");
    await cli.expectExit(1);
  });

  test("refuses a test without a runner", async ({ halinka }) => {
    const tested = halinka.run(["agent", "test", "codex"]);

    await tested.expectOutput("Give the runner with --runner.");
    await tested.expectExit(1);
  });
});
