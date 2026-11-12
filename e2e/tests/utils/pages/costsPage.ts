import { expect, type Page } from "@playwright/test";

export class CostsPage {
  constructor(private readonly page: Page) {}

  async expectRepo(name: string) {
    const section = this.page.getByRole("region", { name: "By repo" });
    await expect(section.getByRole("row", { name })).toBeVisible();
    return this;
  }
}
