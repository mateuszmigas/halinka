import { expect, type Page } from "@playwright/test";

export type ServerUpdate = {
  latestVersion: string;
  isProtocolChange: boolean;
  command: "start" | "server";
};

export class UpdateBanner {
  constructor(private readonly page: Page) {}

  private get banner() {
    return this.page.getByRole("alert").filter({ hasText: "is available" });
  }

  async expectText(text: string) {
    await expect(this.banner).toContainText(text);
    return this;
  }
}
