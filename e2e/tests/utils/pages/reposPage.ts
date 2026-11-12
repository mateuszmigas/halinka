import { expect, type Page } from "@playwright/test";

import { RepoPage } from "./repoPage";
import { selectOption } from "./select";

export class ReposPage {
  constructor(private readonly page: Page) {}

  async register(runner: string, path: string) {
    await this.openAddRepo();
    await selectOption(this.page, "Runner", runner);
    await this.page.getByLabel("Repo path").fill(path);
    await this.page.getByRole("button", { name: "Register" }).click();
    return this;
  }

  async registerFromFolderList(runner: string, startFolder: string, name: string) {
    await this.openAddRepo();
    await selectOption(this.page, "Runner", runner);
    await this.page.getByLabel("Repo path").fill(startFolder);
    await this.page.getByRole("button", { name: "Browse" }).click();
    const row = this.page
      .getByRole("listitem")
      .filter({ has: this.page.getByText(name, { exact: true }) });
    await row.getByRole("button").click();
    await this.page.getByRole("button", { name: "Use this folder" }).click();
    await this.page.getByRole("button", { name: "Register" }).click();
    return this;
  }

  async initAndRegister(runner: string, path: string, devcontainerOption: string) {
    await this.register(runner, path);
    await selectOption(this.page, "Devcontainer", devcontainerOption);
    await this.page.getByRole("button", { name: "Init and register" }).click();
    return this;
  }

  async openRepo(name: string) {
    await this.repoLink(name).click();
    return new RepoPage(this.page);
  }

  async expectRepo(name: string) {
    await expect(this.repoLink(name)).toBeVisible();
    return this;
  }

  private async openAddRepo() {
    await this.page.getByRole("button", { name: "Add repo" }).click();
  }

  private repoLink(name: string) {
    return this.page.getByRole("link", { name, exact: true });
  }
}
