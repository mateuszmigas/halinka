import { expect, type Page } from "@playwright/test";

import type { HalinkaServer } from "./halinkaServer";
import { AgentsPage } from "./pages/agentsPage";
import { CostsPage } from "./pages/costsPage";
import { GitHubPage } from "./pages/githubPage";
import { HomePage } from "./pages/homePage";
import { InboxPage } from "./pages/inboxPage";
import { ReposPage } from "./pages/reposPage";
import { RunnersPage } from "./pages/runnersPage";
import { RunPage } from "./pages/runPage";
import { RunsPage, startRunFrom, type StartRunOptions } from "./pages/runsPage";

export class TestPortal {
  constructor(
    private readonly page: Page,
    private readonly server: HalinkaServer,
  ) {}

  private get nav() {
    return this.page.getByRole("navigation", { name: "Main" });
  }

  async openHome() {
    await this.page.goto(`${this.server.url}/`);
    return new HomePage(this.page);
  }

  async openRuns() {
    await this.page.goto(`${this.server.url}/runs`);
    return new RunsPage(this.page);
  }

  async openRun(id: number) {
    await this.page.goto(`${this.server.url}/runs/${id}`);
    return new RunPage(this.page, id);
  }

  async openRepos() {
    await this.page.goto(`${this.server.url}/repos`);
    return new ReposPage(this.page);
  }

  async openAgents() {
    await this.page.goto(`${this.server.url}/agents`);
    return new AgentsPage(this.page);
  }

  async openCosts() {
    await this.page.goto(`${this.server.url}/costs`);
    return new CostsPage(this.page);
  }

  async openRunners() {
    await this.page.goto(`${this.server.url}/runners`);
    return new RunnersPage(this.page);
  }

  // The link that `halinka runner` prints.
  async openApproveLink(link: string) {
    await this.page.goto(link);
    return new RunnersPage(this.page);
  }

  async openGitHub() {
    await this.page.goto(`${this.server.url}/github`);
    return new GitHubPage(this.page);
  }

  async openInbox() {
    await this.page.goto(`${this.server.url}/inbox`);
    return new InboxPage(this.page);
  }

  async openFromNav(label: string) {
    await this.nav.getByRole("link", { name: label }).click();
  }

  async openMenuTab() {
    await this.page
      .getByRole("navigation", { name: "Tab bar" })
      .getByRole("button", { name: "Menu" })
      .click();
  }

  async expectNavLink(label: string, text = label) {
    await expect(this.nav.getByRole("link", { name: label })).toContainText(text);
  }

  async startRunFromSidebar(options: StartRunOptions) {
    const newRunButton = this.page
      .locator("[data-sidebar=header]")
      .getByRole("button", { name: "New run" });
    return startRunFrom(this.page, newRunButton, options);
  }

  async expectNoPopover() {
    await expect(this.page.getByRole("dialog")).toBeHidden();
  }

  async foldSidebar() {
    await this.page.getByRole("button", { name: "Toggle Sidebar" }).first().click();
  }

  async expectSidebarFolded() {
    await expect(this.page.locator("[data-slot=sidebar][data-state]")).toHaveAttribute(
      "data-state",
      "collapsed",
    );
  }

  async selectTheme(theme: "Light" | "Dark" | "System") {
    await this.page.getByRole("button", { name: "Theme" }).click();
    await this.page.getByRole("menuitemradio", { name: theme }).click();
  }

  async reload() {
    await this.page.reload();
  }

  async expectDarkTheme() {
    await expect(this.page.locator("html")).toHaveClass(/\bdark\b/);
  }
}
