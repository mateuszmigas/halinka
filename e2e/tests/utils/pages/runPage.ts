import { expect, type Page } from "@playwright/test";

import { ChatPanel } from "./chatPanel";
import { RunsPage } from "./runsPage";

export class RunPage {
  readonly chat: ChatPanel;

  constructor(
    private readonly page: Page,
    readonly id: number,
  ) {
    this.chat = new ChatPanel(page);
  }

  static async opened(page: Page) {
    await expect(page).toHaveURL(/\/runs\/\d+$/);
    return new RunPage(page, Number(page.url().split("/").at(-1)));
  }

  async openRunsFromBreadcrumb() {
    await this.page
      .getByRole("navigation", { name: "breadcrumb" })
      .getByRole("link", { name: "Runs" })
      .click();
    return new RunsPage(this.page);
  }

  async expectTestRun() {
    await expect(this.page.getByText("Test run", { exact: true })).toBeVisible();
    return this;
  }

  async expectWaits(reason: string) {
    await expect(this.page.getByText(reason)).toBeVisible();
    return this;
  }

  async cancel() {
    await this.page.getByRole("button", { name: "Cancel run" }).click();
    await this.dialog.getByRole("button", { name: "Cancel run" }).click();
    return this;
  }

  async reopenStep(stepId: string, message: string) {
    await this.selectStep(stepId);
    await this.stepPanel.getByRole("button", { name: "Reopen" }).click();
    await this.dialog.getByLabel("Message to the agent").fill(message);
    await this.dialog.getByRole("button", { name: "Reopen" }).click();
    await expect(this.dialog).toBeHidden();
    return this;
  }

  async expectStatus(status: string) {
    await expect(this.page.getByRole("heading", { level: 1 })).toContainText(status);
    return this;
  }

  async expectStep(stepId: string, status: string) {
    await expect(this.stepButton(stepId)).toContainText(status);
    return this;
  }

  async selectIteration(loopStepId: string, iteration: number) {
    await this.page
      .getByRole("tablist", { name: `Iterations of ${loopStepId}` })
      .last()
      .getByRole("tab", { name: String(iteration), exact: true })
      .click();
    return this;
  }

  async openOutputs(stepId: string) {
    await this.selectStep(stepId);
    await this.stepPanel.getByText("Outputs", { exact: true }).click();
    return this;
  }

  async expectOutputVisible(stepId: string, name: string) {
    await this.selectStep(stepId);
    await expect(this.outputOf(name)).toBeVisible();
    return this;
  }

  async expectOutputHidden(stepId: string, name: string) {
    await this.selectStep(stepId);
    await expect(this.outputOf(name)).toBeHidden();
    return this;
  }

  async expectBranch(branch: string) {
    await expect(this.page.getByText(branch, { exact: true })).toBeVisible();
    return this;
  }

  async openStep(stepId: string) {
    await this.selectStep(stepId);
    await expect(this.stepList).toBeHidden();
    return this;
  }

  async openStepList() {
    await this.stepListButton.click();
    await expect(this.stepList).toBeVisible();
    return this;
  }

  async openStepFromLink() {
    await this.page.goto(`${this.page.url()}?pane=step`);
    await expect(this.stepList).toBeHidden();
    return this;
  }

  async expectStepListButtonFocused() {
    await expect(this.stepListButton).toBeFocused();
    return this;
  }

  async expectStepFocused(stepId: string) {
    await expect(this.stepButton(stepId)).toBeFocused();
    return this;
  }

  async goBack() {
    await this.page.goBack();
    return this;
  }

  async goBackToRuns() {
    await this.page.goBack();
    return new RunsPage(this.page);
  }

  async expectStepList() {
    await expect(this.stepList).toBeVisible();
    await expect(this.stepPanel).toBeHidden();
    return this;
  }

  private get dialog() {
    return this.page.getByRole("alertdialog");
  }

  private async selectStep(stepId: string) {
    await this.stepButton(stepId).click();
    await expect(this.stepPanel.getByRole("heading", { level: 2 })).toContainText(stepId);
  }

  private get stepListButton() {
    return this.page.getByRole("button", { name: "Steps", exact: true });
  }

  private get stepList() {
    return this.page.getByRole("navigation", { name: "Steps" });
  }

  private get stepPanel() {
    return this.page.getByRole("region", { name: "Selected step" });
  }

  // A reopen keeps the old step run as superseded.
  private stepButton(stepId: string) {
    return this.stepList
      .getByRole("button")
      .filter({ has: this.page.getByText(stepId, { exact: true }) })
      .filter({ hasNotText: "superseded" })
      .last();
  }

  private outputOf(name: string) {
    return this.stepPanel.getByText(name, { exact: true });
  }
}
