import { type BrowserContext, expect, type Page } from "@playwright/test";

import { RunPage } from "./runPage";
import { StepProperties } from "./stepProperties";

export class WorkflowPage {
  constructor(private readonly page: Page) {}

  async expectLoaded() {
    await expect(
      this.page.getByRole("textbox", { name: "Workflow source", includeHidden: true }),
    ).toBeAttached();
    return this;
  }

  async selectStep(stepId: string) {
    await this.page
      .getByRole("region", { name: "Workflow steps" })
      .getByText(stepId, { exact: true })
      .click();
    return new StepProperties(this.page.getByRole("region", { name: "Step properties" }));
  }

  async openInOtherTab(context: BrowserContext) {
    const tab = await context.newPage();
    await tab.goto(this.page.url());
    return new WorkflowPage(tab);
  }

  async applyFixes() {
    await this.page.getByRole("button", { name: "Apply fixes", exact: true }).click();
    return this;
  }

  async expectNote(text: string) {
    await expect(this.page.getByText(text)).toBeVisible();
    return this;
  }

  async openCode() {
    await this.page.getByRole("tab", { name: "Code" }).click();
    return this;
  }

  async typeInSource(text: string) {
    await this.openCode();
    const source = this.page.getByRole("region", { name: "YAML editor" });
    await source.getByRole("textbox", { name: "Workflow source" }).focus();
    await this.page.keyboard.type(text);
    return this;
  }

  async acceptCompletion(label: string) {
    await expect(this.page.getByRole("option", { name: label }).first()).toBeVisible();
    await this.page.keyboard.press("Enter");
    return this;
  }

  async expectSourceText(text: string) {
    const source = this.page.getByRole("region", { name: "YAML editor" });
    await expect(source.getByText(text, { exact: true }).first()).toBeVisible();
    return this;
  }

  async undoInSource() {
    const source = this.page.getByRole("region", { name: "YAML editor" });
    await source.getByRole("textbox", { name: "Workflow source" }).focus();
    await this.page.keyboard.press("ControlOrMeta+z");
    return this;
  }

  async undo() {
    await this.page.getByRole("button", { name: "Undo", exact: true }).click();
    return this;
  }

  async returnToPage() {
    await this.page.evaluate("window.dispatchEvent(new Event('visibilitychange'))");
    return this;
  }

  async expectNoUndo() {
    await expect(this.page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    return this;
  }

  async redoWithKeys() {
    await this.page.keyboard.press("ControlOrMeta+Shift+z");
    return this;
  }

  async showChanges() {
    await this.page.getByRole("button", { name: "Show changes" }).click();
    return this;
  }

  async hideChanges() {
    await this.page.getByRole("button", { name: "Hide changes" }).click();
    return this;
  }

  async discardDraft() {
    await this.page.getByRole("button", { name: "Discard draft" }).click();
    return this;
  }

  async expectSourceShown() {
    await expect(this.page.getByRole("button", { name: "Show changes" })).toBeVisible();
    await expect(this.page.getByRole("region", { name: "Changes of the draft" })).toBeHidden();
    return this;
  }

  async expectChanges(removed: string, added: string) {
    const changes = this.page.getByRole("region", { name: "Changes of the draft" });
    await expect(changes.getByText(removed, { exact: true }).first()).toBeVisible();
    await expect(changes.getByText(added, { exact: true }).first()).toBeVisible();
    return this;
  }

  async expectSaved() {
    await expect(this.page.getByText("All changes saved")).toBeVisible();
    return this;
  }

  async expectUnsaved() {
    await expect(this.page.getByText("Unsaved changes")).toBeVisible();
    return this;
  }

  async expectStep(stepId: string) {
    await expect(
      this.page.getByRole("region", { name: "Workflow steps" }).getByText(stepId, { exact: true }),
    ).toBeVisible();
    return this;
  }

  async save() {
    await this.page.getByRole("button", { name: "Save" }).click();
    await expect(this.page.getByText("All changes saved")).toBeVisible();
    return this;
  }

  async startTestRun() {
    await this.page.getByRole("button", { name: "Start test run" }).click();
    return RunPage.opened(this.page);
  }

  async startRun() {
    await this.page.getByRole("button", { name: "Start run" }).click();
    return RunPage.opened(this.page);
  }
}
