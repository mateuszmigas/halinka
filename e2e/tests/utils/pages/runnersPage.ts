import { expect, type Page } from "@playwright/test";

import { rowWithCell, selectRowAction } from "./rows";

export class RunnersPage {
  constructor(private readonly page: Page) {}

  async setLabels(runner: string, labels: string) {
    await selectRowAction(this.page, this.runnerRow(runner), runner, "Edit");
    const field = this.page.getByLabel("Labels", { exact: true });
    await field.fill(labels);
    await this.page.getByRole("button", { name: "Save" }).click();
    // The portal closes the form after it stores the labels.
    await expect(field).toBeHidden();
    return this;
  }

  async approve(name: string) {
    const popover = this.page.getByRole("dialog");
    await popover.getByLabel("Name", { exact: true }).fill(name);
    await popover.getByRole("button", { name: "Approve", exact: true }).click();
    // The portal closes the popover after it approves the runner.
    await expect(popover).toBeHidden();
    return this;
  }

  async expectLabels(runner: string, labels: string) {
    await expect(this.runnerRow(runner)).toContainText(labels);
    return this;
  }

  async expectStatus(runner: string, status: string) {
    await expect(this.runnerRow(runner)).toContainText(status);
    return this;
  }

  private runnerRow(runner: string) {
    return rowWithCell(this.page, runner);
  }
}
