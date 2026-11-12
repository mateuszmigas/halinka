import { test, TestPortal } from "../utils";

test.describe("costs", () => {
  test("shows the repo of a finished agent attempt", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startWithAgent([[{ report: { summary: "Done" } }]]);
    const portal = new TestPortal(page, server);
    const runsPage = await portal.openRuns();
    const runPage = await runsPage.startRun({ repo: repo.name, workflow: "Agent" });
    await runPage.expectStatus("succeeded");

    const costsPage = await portal.openCosts();

    await costsPage.expectRepo(repo.name);
  });
});
