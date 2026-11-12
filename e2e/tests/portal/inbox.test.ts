import type { FakeTurn } from "@halinka/agents/testing";

import { test, TestPortal } from "../utils";

const reviewWorkflow = [
  "schema_version: 1",
  "name: Ship",
  "steps:",
  "  - { id: review, type: approval, message: Check the diff }",
  "  - { id: ship, type: shell, run: echo shipped }",
  "",
].join("\n");

const options = [
  { label: "Postgres", description: "A server" },
  { label: "SQLite", description: "A file" },
];
const askDatabase: FakeTurn[] = [
  [{ question: { questions: [{ header: "Database", question: "Which database?", options }] } }],
  [{ echo: true }, { report: { summary: "Used the answer" } }],
];

test.describe("inbox", () => {
  test("continues a run when a person approves it in the inbox", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({ "ship.yml": reviewWorkflow });
    const portal = new TestPortal(page, server);
    const runsPage = await portal.openRuns();
    const runPage = await runsPage.startRun({ repo: repo.name, workflow: "Ship" });
    await runPage.expectStatus("waiting input");
    const inboxPage = await portal.openInbox();

    await inboxPage.item(runPage.id, "review").approve();

    const approvedRun = await portal.openRun(runPage.id);
    await approvedRun.expectStatus("succeeded");
  });

  test("counts a new item in the link of the inbox, with no reload", async ({ halinka, page }) => {
    const { server } = await halinka.startInRepo({ "ship.yml": reviewWorkflow });
    const portal = new TestPortal(page, server);
    await portal.openRuns();
    const [repo] = (await server.get("/api/repos")) as { id: number }[];

    await server.postJson("/api/runs", { repoId: repo!.id, workflow: "ship" });

    await portal.expectNavLink("Inbox", "1");
  });

  test("gives the option that a person selects to the agent", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startWithAgent(askDatabase);
    const runsPage = await new TestPortal(page, server).openRuns();
    const runPage = await runsPage.startRun({ repo: repo.name, workflow: "Agent" });

    await runPage.chat.inboxItem("work").answer("Postgres");

    await runPage.chat.expectAgentText("Answer: Postgres");
  });

  test("gives the text that a person writes to the agent", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startWithAgent(askDatabase);
    const runsPage = await new TestPortal(page, server).openRuns();
    const runPage = await runsPage.startRun({ repo: repo.name, workflow: "Agent" });

    await runPage.chat.inboxItem("work").answerOther("MySQL");

    await runPage.chat.expectAgentText("Answer: Other: MySQL");
  });
});
