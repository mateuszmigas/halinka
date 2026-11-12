import { test, TestPortal } from "../utils";

test.describe("chat", () => {
  test("gives a message of a person to the running agent", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startWithAgent([
      [{ say: "Waiting for a message" }, { wait: true }],
      [{ echo: true }, { report: { summary: "Done" } }],
    ]);
    const runsPage = await new TestPortal(page, server).openRuns();
    const runPage = await runsPage.startRun({ repo: repo.name, workflow: "Agent" });
    await runPage.chat.expectAgentText("Waiting for a message");

    await runPage.chat.send("Use tabs");

    await runPage.chat.expectAgentText("Use tabs");
  });
});
