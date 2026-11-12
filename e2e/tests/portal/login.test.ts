import { expect } from "@playwright/test";

import { test, TestPortal } from "../utils";

test.describe("login", () => {
  test("sends the person from the login page to GitHub", async ({ halinka, page }) => {
    halinka.setLogin("https://halinka.example.com");
    const server = await halinka.startServer();
    await page.route("https://github.com/**", (route) =>
      route.fulfill({ status: 200, body: "GitHub" }),
    );

    await page.goto(`${server.url}/runs`);
    await page.getByRole("button", { name: "Log in with GitHub" }).click();

    await page.waitForURL("https://github.com/login/oauth/authorize**");
    expect(new URL(page.url()).searchParams.get("client_id")).toBe("test-client");
  });

  test("says why a login was refused", async ({ halinka, page }) => {
    halinka.setLogin("https://halinka.example.com");
    const server = await halinka.startServer();

    await page.goto(`${server.url}/runs?login=refused`);

    await expect(page.getByText("An Admin of this server must add your GitHub user")).toBeVisible();
  });

  test("shows the login page when a session ends during the visit", async ({ halinka, page }) => {
    const server = await halinka.start();
    const portal = new TestPortal(page, server);
    await portal.openRuns();
    await portal.expectNavLink("Runs");
    await page.route("**/api/session", (route) =>
      route.fulfill({ json: { isLoginRequired: true } }),
    );
    await page.route("**/api/runs**", (route) =>
      route.fulfill({ status: 401, json: { code: "UNAUTHORIZED", message: "Log in first" } }),
    );

    await portal.openFromNav("Inbox");
    await portal.openFromNav("Runs");

    await expect(page.getByRole("button", { name: "Log in with GitHub" })).toBeVisible();
  });

  test("shows the login page when a form gets a refused session", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({});
    const reposPage = await new TestPortal(page, server).openRepos();
    const repoPage = await reposPage.openRepo(repo.name);
    await page.route("**/api/session", (route) =>
      route.fulfill({ json: { isLoginRequired: true } }),
    );
    await page.route("**/api/repos/*/secrets/*", (route) =>
      route.fulfill({ status: 401, json: { code: "UNAUTHORIZED", message: "Log in first" } }),
    );

    await repoPage.storeSecret("NPM_TOKEN", "npm_made_up_value");

    await expect(page.getByRole("button", { name: "Log in with GitHub" })).toBeVisible();
  });

  test("shows no login page on this machine", async ({ halinka, page }) => {
    const server = await halinka.start();

    const portal = new TestPortal(page, server);

    await portal.openRuns();

    await portal.expectNavLink("Runs");
    await expect(page.getByRole("button", { name: "Log in with GitHub" })).toBeHidden();
  });
});
