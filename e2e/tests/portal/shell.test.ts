import { shellWorkflow, test, TestPortal } from "../utils";

test.describe("shell", () => {
  test("keeps the sidebar folded after a reload", async ({ halinka, page }) => {
    const server = await halinka.start();
    const portal = new TestPortal(page, server);
    await portal.openRuns();
    await portal.foldSidebar();

    await portal.reload();

    await portal.expectSidebarFolded();
  });

  test("closes the New run popover of the sidebar when the run starts", async ({
    halinka,
    page,
  }) => {
    const { repo, server } = await halinka.startInRepo({
      "echo.yml": shellWorkflow("echo hi", "Echo"),
    });
    const portal = new TestPortal(page, server);
    await portal.openHome();

    await portal.startRunFromSidebar({ repo: repo.name, workflow: "Echo" });

    await portal.expectNoPopover();
  });

  test("goes back to Runs from the breadcrumb of a run", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({
      "echo.yml": shellWorkflow("echo hi", "Echo"),
    });
    const runsPage = await new TestPortal(page, server).openRuns();
    const runPage = await runsPage.startRun({ repo: repo.name, workflow: "Echo" });
    const runsPageAgain = await runPage.openRunsFromBreadcrumb();

    await runsPageAgain.expectOpened();
  });

  test.describe("on a phone", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("opens the sidebar sheet from the Menu tab", async ({ halinka, page }) => {
      const server = await halinka.start();
      const portal = new TestPortal(page, server);
      await portal.openHome();

      await portal.openMenuTab();

      await portal.expectNavLink("Repos");
    });
  });
});
