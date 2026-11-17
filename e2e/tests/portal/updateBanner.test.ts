import { test, TestPortal } from "../utils";

test.describe("update banner", () => {
  test("gives the Compose commands of a new version", async ({ halinka, page }) => {
    const server = await halinka.start();
    const portal = new TestPortal(page, server);
    await portal.answerServerUpdate({
      latestVersion: "9.0.0",
      isProtocolChange: false,
      isComposeChange: false,
      command: "server",
    });

    const homePage = await portal.openHome();

    await homePage.updateBanner().expectText("docker compose pull");
  });

  test("gives the start command on a server of halinka start", async ({ halinka, page }) => {
    const server = await halinka.start();
    const portal = new TestPortal(page, server);
    await portal.answerServerUpdate({
      latestVersion: "9.0.0",
      isProtocolChange: false,
      isComposeChange: false,
      command: "start",
    });

    const homePage = await portal.openHome();

    await homePage.updateBanner().expectText("npx halinka@latest start");
  });

  test("says that each runner updates after a protocol change", async ({ halinka, page }) => {
    const server = await halinka.start();
    const portal = new TestPortal(page, server);
    await portal.answerServerUpdate({
      latestVersion: "9.0.0",
      isProtocolChange: true,
      isComposeChange: false,
      command: "server",
    });

    const homePage = await portal.openHome();

    await homePage
      .updateBanner()
      .expectText("each runner stops its runs and installs the new version");
  });

  test("says to download the Compose files after a Compose change", async ({ halinka, page }) => {
    const server = await halinka.start();
    const portal = new TestPortal(page, server);
    await portal.answerServerUpdate({
      latestVersion: "9.0.0",
      isProtocolChange: false,
      isComposeChange: true,
      command: "server",
    });

    const homePage = await portal.openHome();

    await homePage.updateBanner().expectText("This version changes the Compose files");
  });
});
