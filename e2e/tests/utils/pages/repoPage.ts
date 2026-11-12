import { expect, type Page } from "@playwright/test";

import { confirmAction, selectRowAction } from "./rows";
import { WorkflowPage } from "./workflowPage";

export class RepoPage {
  constructor(private readonly page: Page) {}

  async createWorkflow(file: string) {
    await this.page.getByRole("button", { name: "New workflow" }).click();
    const popover = this.page.getByRole("dialog");
    await popover.getByLabel("Workflow file name").fill(file);
    await popover.getByRole("button", { name: "Create" }).click();
    return new WorkflowPage(this.page).expectLoaded();
  }

  async storeSecret(name: string, value: string) {
    await this.secrets().getByRole("button", { name: "Add secret" }).click();
    const popover = this.page.getByRole("dialog");
    await popover.getByLabel("Name").fill(name);
    await popover.getByLabel("Value").fill(value);
    await popover.getByRole("button", { name: "Save secret" }).click();
    await expect(popover).toBeHidden();
    return this;
  }

  async deleteSecret(name: string) {
    const row = this.secrets().getByRole("row", { name });
    await selectRowAction(this.page, row, name, "Delete");
    await confirmAction(this.page, "Delete");
    return this;
  }

  async expectSecret(name: string) {
    await expect(this.secrets().getByRole("row", { name })).toBeVisible();
    return this;
  }

  async expectNoSecret(name: string) {
    await expect(this.secrets().getByRole("row", { name })).toHaveCount(0);
    return this;
  }

  async openProblem(text: string) {
    await this.page.getByRole("link", { name: text }).click();
    return new WorkflowPage(this.page).expectLoaded();
  }

  async openWorkflow(name: string) {
    await this.page.getByRole("link", { name, exact: true }).click();
    return new WorkflowPage(this.page).expectLoaded();
  }

  private secrets() {
    return this.page.getByRole("region", { name: "Secrets" });
  }
}
