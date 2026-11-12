import { test, TestPortal } from "../utils";

test.describe("theme", () => {
  test("keeps the dark theme after a reload", async ({ halinka, page }) => {
    const server = await halinka.start();
    await page.emulateMedia({ colorScheme: "light" });
    const portal = new TestPortal(page, server);
    await portal.openRuns();
    await portal.selectTheme("Dark");

    await portal.reload();

    await portal.expectDarkTheme();
  });
});
