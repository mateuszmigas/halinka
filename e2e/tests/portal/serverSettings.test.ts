import { test, TestPortal } from "../utils";

test.describe("server settings", () => {
  test("turns off the update check", async ({ halinka, page }) => {
    const server = await halinka.start();
    const portal = new TestPortal(page, server);
    const settingsPage = await portal.openServerSettings();

    await settingsPage.turnOffUpdateCheck();

    const reloaded = await portal.openServerSettings();
    await reloaded.expectUpdateCheck(false);
  });
});
