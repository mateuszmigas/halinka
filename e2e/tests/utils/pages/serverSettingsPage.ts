import { expect, type Page } from "@playwright/test";

export class ServerSettingsPage {
  constructor(private readonly page: Page) {}

  private get updateCheck() {
    return this.page.getByRole("switch", { name: "Check for updates" });
  }

  async turnOffUpdateCheck() {
    await expect(this.updateCheck).toBeChecked();
    await this.updateCheck.click();
    await expect(this.updateCheck).toBeChecked({ checked: false });
    await expect(this.updateCheck).toBeEnabled();
    return this;
  }

  async expectUpdateCheck(isOn: boolean) {
    await expect(this.updateCheck).toBeChecked({ checked: isOn });
    return this;
  }
}
