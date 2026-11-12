import type { Locator } from "@playwright/test";

export class StepProperties {
  constructor(private readonly panel: Locator) {}

  async fill(field: string, value: string) {
    await this.panel.getByLabel(field, { exact: true }).fill(value);
    return this;
  }

  async type(field: string, text: string) {
    await this.panel.getByLabel(field, { exact: true }).pressSequentially(text);
    return this;
  }
}
