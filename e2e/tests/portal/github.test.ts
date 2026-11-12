import { expect } from "@playwright/test";

import { test, TestPortal } from "../utils";

test.describe("GitHub App", () => {
  test("posts the manifest of the App to GitHub", async ({ halinka, page }) => {
    const server = await halinka.start();
    const portal = new TestPortal(page, server);

    const github = await portal.openGitHub();
    const { url, manifest } = await github.createApp("acme");

    expect(url.pathname).toBe("/organizations/acme/settings/apps/new");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(manifest.redirect_url).toBe(`${server.url}/github/created`);
  });

  test("asks for the name of an organization", async ({ halinka, page }) => {
    const server = await halinka.start();
    const portal = new TestPortal(page, server);

    const github = await portal.openGitHub();
    await github.expectOrganizationRequired();
  });
});
