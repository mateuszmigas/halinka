import { test, TestPortal } from "../utils";

test.describe("agents", () => {
  test("stores a key", async ({ halinka, page }) => {
    const server = await halinka.start();
    const portal = new TestPortal(page, server);
    const agentsPage = await portal.openAgents();

    await agentsPage.storeKey("Claude Code", "ANTHROPIC_API_KEY", "sk-ant-api03-made-up-value");

    const reloaded = await portal.openAgents();
    await reloaded.expectKeyState("Claude Code", "ANTHROPIC_API_KEY", "Set");
  });

  // The server of this test has no login, so the list gives no keys of a person.
  test("names the refusal of a key of a person", async ({ halinka, page }) => {
    const server = await halinka.start();
    const portal = new TestPortal(page, server);
    await page.route("**/api/agents", async (route) => {
      const answer = await route.fetch();
      const agents = (await answer.json()) as { credentials: object[] }[];
      const json = agents.map((agent) => ({
        ...agent,
        mine: { credentials: agent.credentials, tests: [] },
      }));
      await route.fulfill({ json });
    });
    const agentsPage = await portal.openAgents();

    await agentsPage.submitOwnKey("Claude Code", "ANTHROPIC_API_KEY", "sk-ant-api03-made-up-value");

    await agentsPage.expectRefusal("This server has no login");
  });

  test("removes a stored key", async ({ halinka, page }) => {
    const server = await halinka.start();
    const portal = new TestPortal(page, server);
    const agentsPage = await portal.openAgents();
    await agentsPage.storeKey("Claude Code", "ANTHROPIC_API_KEY", "sk-ant-api03-made-up-value");

    await agentsPage.deleteKey("Claude Code", "ANTHROPIC_API_KEY");

    await agentsPage.expectKeyState("Claude Code", "ANTHROPIC_API_KEY", "Not set");
  });

  test("names the problem of a version that the server refuses", async ({ halinka, page }) => {
    const server = await halinka.start();
    const portal = new TestPortal(page, server);
    const agentsPage = await portal.openAgents();

    await agentsPage.submitVersion("Codex", "latest");

    await agentsPage.expectRefusal("Use an exact version");
  });

  test("saves a corrected version after a refusal", async ({ halinka, page }) => {
    const server = await halinka.start();
    const portal = new TestPortal(page, server);
    const agentsPage = await portal.openAgents();
    await agentsPage.submitVersion("Codex", "latest");
    await agentsPage.expectRefusal("Use an exact version");

    await agentsPage.correctVersion("Codex", "1.2.3");

    const reloaded = await portal.openAgents();
    await reloaded.expectSummary("Codex", "version 1.2.3");
  });

  test("keeps the default model of an agent", async ({ halinka, page }) => {
    const server = await halinka.start();
    const portal = new TestPortal(page, server);
    const agentsPage = await portal.openAgents();

    await agentsPage.selectModel("Codex", "gpt-5.1");

    const reloaded = await portal.openAgents();
    await reloaded.expectSummary("Codex", "model gpt-5.1");
  });

  test("keeps an agent disabled when its version changes", async ({ halinka, page }) => {
    const server = await halinka.start();
    const portal = new TestPortal(page, server);
    const agentsPage = await portal.openAgents();

    await agentsPage.toggle("Codex", "Disable");
    await agentsPage.selectVersion("Codex", "1.2.3");

    const reloaded = await portal.openAgents();
    await reloaded.expectSummary("Codex", "Disabled");
  });

  test("tests an agent on a runner", async ({ halinka, page }) => {
    await halinka.installFakeAgent("claude-code");
    const server = await halinka.start();
    const portal = new TestPortal(page, server);
    const agentsPage = await portal.openAgents();
    const runner = await halinka.readLocalRunnerName();

    await agentsPage.test("Claude Code", runner);

    await agentsPage.expectTest("Claude Code", runner, "Passed");
  });
});
