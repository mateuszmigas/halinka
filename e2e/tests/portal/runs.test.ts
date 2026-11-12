import { type FakeAction, fakeAgentPrompt } from "@halinka/agents/testing";
import { expect } from "@playwright/test";

import { shellWorkflow, test, TestPortal } from "../utils";

const fixWorkflow = [
  "schema_version: 1",
  "name: Fix",
  "inputs:",
  "  issue: { type: number, required: true }",
  "branch:",
  "  name: fix/issue-${{ inputs.issue }}",
  "steps:",
  "  - { id: notes, type: shell, run: echo notes > notes.md }",
  "",
].join("\n");

const sleepWorkflow = shellWorkflow("sleep 60", "Sleep");
const echoWorkflow = shellWorkflow("echo hi", "Echo");

const loopWorkflow = [
  "schema_version: 1",
  "name: Loop",
  "steps:",
  "  - id: repeat",
  "    type: loop",
  "    max_iterations: 2",
  "    until: ${{ steps.first.status == 'skipped' }}",
  "    steps:",
  "      - id: first",
  "        type: shell",
  "        if: ${{ loop.iteration == 1 }}",
  "        run: echo first",
  "",
].join("\n");

const oneAgentStep = (agent: string, action: FakeAction) => {
  const prompt = fakeAgentPrompt([[action, { report: { summary: "Done" } }]]);
  return [
    "schema_version: 1",
    "name: One step",
    "steps:",
    `  - { id: work, type: agent, require_changes: false, agent: ${agent}, prompt: ${JSON.stringify(prompt)} }`,
    "",
  ].join("\n");
};

test.describe("runs", () => {
  test("lists a run that started elsewhere, with no reload", async ({ halinka, page }) => {
    const { server } = await halinka.startInRepo({ "sleep.yml": sleepWorkflow });
    await new TestPortal(page, server).openRuns();
    const [repo] = (await server.get("/api/repos")) as { id: number }[];

    await server.postJson("/api/runs", { repoId: repo!.id, workflow: "sleep" });

    await expect(page.getByRole("cell", { name: "Sleep" })).toBeVisible();
  });

  test("starts a run with its inputs from the Runs page", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({ "fix.yml": fixWorkflow });
    const runsPage = await new TestPortal(page, server).openRuns();

    const runPage = await runsPage.startRun({
      repo: repo.name,
      workflow: "Fix",
      inputs: { issue: "12" },
    });

    await runPage.expectStatus("succeeded");
    await runPage.expectBranch("fix/issue-12");
  });

  test("shows the outputs of a step after a person opens them", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startWithAgent([[{ report: { summary: "Done" } }]]);
    const runsPage = await new TestPortal(page, server).openRuns();
    const runPage = await runsPage.startRun({ repo: repo.name, workflow: "Agent" });
    await runPage.expectStatus("succeeded");
    await runPage.expectOutputHidden("work", "commit");

    await runPage.openOutputs("work");

    await runPage.expectOutputVisible("work", "commit");
  });

  test("shows the messages of an agent in the chat", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startWithAgent([
      [{ say: "Writing the notes" }, { report: { summary: "Wrote the notes" } }],
    ]);
    const runsPage = await new TestPortal(page, server).openRuns();

    const runPage = await runsPage.startRun({ repo: repo.name, workflow: "Agent" });

    await runPage.chat.expectAgentText("Writing the notes");
  });

  test("gives the default model of the Agents page to a step", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startWithAgent([
      [{ model: true }, { report: { summary: "Done" } }],
    ]);
    const portal = new TestPortal(page, server);
    const agentsPage = await portal.openAgents();
    await agentsPage.selectModel("Claude Code", "fake-large");
    const runsPage = await portal.openRuns();

    const runPage = await runsPage.startRun({ repo: repo.name, workflow: "Agent" });

    await runPage.chat.expectAgentText("fake-large");
  });

  test("gives the tools of a step to Claude Code", async ({ halinka, page }) => {
    await halinka.installFakeAgent("claude-code");
    const { repo, server } = await halinka.startInRepo({
      "tools.yml": oneAgentStep("claude-code, tools: [Read]", { session: true }),
    });
    const runsPage = await new TestPortal(page, server).openRuns();

    const runPage = await runsPage.startRun({ repo: repo.name, workflow: "One step" });

    await runPage.chat.expectAgentText('"claudeCode":{"options":{"tools":["Read"]}}');
  });

  test("gives the environment of its preset to Codex", async ({ halinka, page }) => {
    await halinka.installFakeAgent("codex");
    const { repo, server } = await halinka.startInRepo({
      "codex.yml": oneAgentStep("codex", { env: "DISABLE_MCP_CONFIG_FILTERING" }),
    });
    const runsPage = await new TestPortal(page, server).openRuns();

    const runPage = await runsPage.startRun({ repo: repo.name, workflow: "One step" });

    await runPage.chat.expectAgentText("true");
  });

  test("cancels a running run", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({ "sleep.yml": sleepWorkflow });
    const runsPage = await new TestPortal(page, server).openRuns();
    const runPage = await runsPage.startRun({ repo: repo.name, workflow: "Sleep" });
    await runPage.expectStatus("running");

    await runPage.cancel();

    await runPage.expectStatus("cancelled");
  });

  test("shows the step runs of an earlier iteration of a loop", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({ "loop.yml": loopWorkflow });
    const runsPage = await new TestPortal(page, server).openRuns();
    const runPage = await runsPage.startRun({ repo: repo.name, workflow: "Loop" });
    await runPage.expectStatus("succeeded");
    await runPage.expectStep("first", "skipped");

    await runPage.selectIteration("repeat", 1);

    await runPage.expectStep("first", "succeeded");
  });

  test("gives the message of a reopen to the agent of the step", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startWithAgent([[{ report: { summary: "First" } }]]);
    const runsPage = await new TestPortal(page, server).openRuns();
    const runPage = await runsPage.startRun({ repo: repo.name, workflow: "Agent" });
    await runPage.expectStatus("succeeded");
    const message = fakeAgentPrompt([[{ say: "Reopened" }, { report: { summary: "Again" } }]]);

    await runPage.reopenStep("work", message);

    await runPage.chat.expectAgentText("Reopened");
  });

  test.describe("on a phone", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("goes back from a step to the step list", async ({ halinka, page }) => {
      const { repo, server } = await halinka.startInRepo({ "echo.yml": echoWorkflow });
      const runsPage = await new TestPortal(page, server).openRuns();
      const runPage = await runsPage.startRun({ repo: repo.name, workflow: "Echo" });
      await runPage.expectStatus("succeeded");
      await runPage.openStep("echo");

      await runPage.goBack();

      await runPage.expectStepList();
    });

    test("goes back to the step list from the Steps button", async ({ halinka, page }) => {
      const { repo, server } = await halinka.startInRepo({ "echo.yml": echoWorkflow });
      const runsPage = await new TestPortal(page, server).openRuns();
      const runPage = await runsPage.startRun({ repo: repo.name, workflow: "Echo" });
      await runPage.expectStatus("succeeded");
      await runPage.openStep("echo");

      await runPage.openStepList();

      await runPage.expectStepList();
    });

    test("leaves the run page on Back after the Steps button", async ({ halinka, page }) => {
      const { repo, server } = await halinka.startInRepo({ "echo.yml": echoWorkflow });
      const runsPage = await new TestPortal(page, server).openRuns();
      const runPage = await runsPage.startRun({ repo: repo.name, workflow: "Echo" });
      await runPage.expectStatus("succeeded");
      await runPage.openStep("echo");
      await runPage.openStepList();

      const runsPageAgain = await runPage.goBackToRuns();

      await runsPageAgain.expectOpened();
    });

    test("opens the step list from the Steps button of a link to a step", async ({
      halinka,
      page,
    }) => {
      const { repo, server } = await halinka.startInRepo({ "echo.yml": echoWorkflow });
      const runsPage = await new TestPortal(page, server).openRuns();
      const runPage = await runsPage.startRun({ repo: repo.name, workflow: "Echo" });
      await runPage.expectStatus("succeeded");
      await runPage.openStepFromLink();

      await runPage.openStepList();

      await runPage.expectStepList();
    });

    test("moves the focus to the pane that opens", async ({ halinka, page }) => {
      const { repo, server } = await halinka.startInRepo({ "echo.yml": echoWorkflow });
      const runsPage = await new TestPortal(page, server).openRuns();
      const runPage = await runsPage.startRun({ repo: repo.name, workflow: "Echo" });
      await runPage.expectStatus("succeeded");
      await runPage.openStep("echo");
      await runPage.expectStepListButtonFocused();

      await runPage.openStepList();

      await runPage.expectStepFocused("echo");
    });

    test("keeps the message of a step after the step list opens", async ({ halinka, page }) => {
      const { repo, server } = await halinka.startWithAgent([
        [{ say: "Waiting for a message" }, { wait: true }],
      ]);
      const runsPage = await new TestPortal(page, server).openRuns();
      const runPage = await runsPage.startRun({ repo: repo.name, workflow: "Agent" });
      await runPage.openStep("work");
      await runPage.chat.expectAgentText("Waiting for a message");
      await runPage.chat.typeMessage("Use tabs");
      await runPage.openStepList();

      await runPage.openStep("work");

      await runPage.chat.expectDraft("Use tabs");
    });
  });
});
