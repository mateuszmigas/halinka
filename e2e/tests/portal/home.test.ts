import { test, TestPortal } from "../utils";

const reviewWorkflow = [
  "schema_version: 1",
  "name: Ship",
  "steps:",
  "  - { id: review, type: approval, message: Check the diff }",
  "  - { id: ship, type: shell, run: echo shipped }",
  "",
].join("\n");

test.describe("home", () => {
  test("continues a run when a person approves it on Home", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({ "ship.yml": reviewWorkflow });
    const portal = new TestPortal(page, server);
    const runsPage = await portal.openRuns();
    const runPage = await runsPage.startRun({ repo: repo.name, workflow: "Ship" });
    await runPage.expectStatus("waiting input");
    const homePage = await portal.openHome();

    await homePage.item(runPage.id).approve();

    const approvedRun = await portal.openRun(runPage.id);
    await approvedRun.expectStatus("succeeded");
  });
});
