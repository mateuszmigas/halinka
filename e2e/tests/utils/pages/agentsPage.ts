import { expect, type Page } from "@playwright/test";

import { confirmAction, selectRowAction } from "./rows";

type PopoverForm = { trigger: string; field: string; value: string; submit: string };

export class AgentsPage {
  constructor(private readonly page: Page) {}

  async storeKey(agent: string, variable: string, value: string) {
    await this.save(agent, {
      trigger: `Set ${variable}`,
      field: `New ${variable}`,
      value,
      submit: "Save",
    });
    await this.expectKeyState(agent, variable, "Set");
    return this;
  }

  async deleteKey(agent: string, variable: string) {
    await selectRowAction(this.page, this.rowOf(agent, variable), variable, "Delete");
    await confirmAction(this.page, "Delete");
    return this;
  }

  async submitOwnKey(agent: string, variable: string, value: string) {
    await this.submit(agent, {
      trigger: `Set your ${variable}`,
      field: `Your new ${variable}`,
      value,
      submit: "Save",
    });
    return this;
  }

  async toggle(agent: string, action: "Enable" | "Disable") {
    const toggle = this.section(agent).getByRole("switch", { name: `Enable ${agent}` });
    await toggle.click();
    await expect(toggle).toBeChecked({ checked: action === "Enable" });
    return this;
  }

  async submitVersion(agent: string, version: string) {
    await this.submit(agent, this.versionForm(agent, version));
    return this;
  }

  async selectVersion(agent: string, version: string) {
    await this.save(agent, this.versionForm(agent, version));
    await this.expectSummary(agent, `version ${version}`);
    return this;
  }

  // A refused save keeps the popover open with the refused value.
  async correctVersion(agent: string, version: string) {
    await this.fillAndSave(this.versionForm(agent, version));
    await this.expectSummary(agent, `version ${version}`);
    return this;
  }

  async selectModel(agent: string, model: string) {
    await this.save(agent, {
      trigger: `Change the default model of ${agent}`,
      field: "Default model",
      value: model,
      submit: "Save model",
    });
    await this.expectSummary(agent, `model ${model}`);
    return this;
  }

  async test(agent: string, runner: string) {
    const popover = await this.openPopover(agent, "Run a test");
    await popover.getByLabel("Test on runner").click();
    await this.page.getByRole("option", { name: runner, exact: true }).click();
    await popover.getByRole("button", { name: "Test", exact: true }).click();
    await expect(popover).toBeHidden();
    return this;
  }

  async expectTest(agent: string, runner: string, result: string) {
    await expect(this.rowOf(agent, runner)).toContainText(result, { timeout: 60_000 });
    return this;
  }

  async expectKeyState(agent: string, variable: string, state: string) {
    await expect(this.rowOf(agent, variable)).toContainText(state);
    return this;
  }

  async expectSummary(agent: string, summary: string) {
    await expect(this.section(agent)).toContainText(summary);
    return this;
  }

  async expectRefusal(message: string) {
    await expect(this.popover()).toContainText(message);
    return this;
  }

  private versionForm(agent: string, version: string): PopoverForm {
    return {
      trigger: `Change the version of ${agent}`,
      field: "Version",
      value: version,
      submit: "Save version",
    };
  }

  private async save(agent: string, form: PopoverForm) {
    await this.openPopover(agent, form.trigger);
    await this.fillAndSave(form);
  }

  private async submit(agent: string, form: PopoverForm) {
    await this.openPopover(agent, form.trigger);
    await this.fill(form);
  }

  private async fillAndSave(form: PopoverForm) {
    await this.fill(form);
    // The portal closes the popover after it stores the value.
    await expect(this.popover()).toBeHidden();
  }

  private async fill({ field, value, submit }: PopoverForm) {
    const popover = this.popover();
    await popover.getByLabel(field, { exact: true }).fill(value);
    await popover.getByRole("button", { name: submit, exact: true }).click();
  }

  private async openPopover(agent: string, trigger: string) {
    await this.section(agent).getByRole("button", { name: trigger, exact: true }).click();
    const popover = this.popover();
    await expect(popover).toBeVisible();
    return popover;
  }

  private popover() {
    return this.page.getByRole("dialog");
  }

  private rowOf(agent: string, cell: string) {
    return this.section(agent)
      .getByRole("row")
      .filter({ has: this.page.getByRole("cell", { name: cell, exact: true }) });
  }

  private section(agent: string) {
    return this.page.getByRole("region", { name: agent, exact: true });
  }
}
