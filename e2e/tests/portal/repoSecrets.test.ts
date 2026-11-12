import { test, TestPortal } from "../utils";

test.describe("repo secrets", () => {
  test("stores a secret", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({});
    const reposPage = await new TestPortal(page, server).openRepos();
    const repoPage = await reposPage.openRepo(repo.name);

    await repoPage.storeSecret("NPM_TOKEN", "npm_made_up_value");

    await repoPage.expectSecret("NPM_TOKEN");
  });

  test("removes a secret", async ({ halinka, page }) => {
    const { repo, server } = await halinka.startInRepo({});
    const reposPage = await new TestPortal(page, server).openRepos();
    const repoPage = await reposPage.openRepo(repo.name);
    await repoPage.storeSecret("NPM_TOKEN", "npm_made_up_value");
    await repoPage.expectSecret("NPM_TOKEN");

    await repoPage.deleteSecret("NPM_TOKEN");

    await repoPage.expectNoSecret("NPM_TOKEN");
  });
});
