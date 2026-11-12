import { expect, type Page } from "@playwright/test";

const gitHubPages = "https://github.com/**";

export class GitHubPage {
  constructor(private readonly page: Page) {}

  async createApp(organization: string) {
    await this.page.route(gitHubPages, (route) => route.fulfill({ status: 200, body: "GitHub" }));
    const posted = this.page.waitForRequest(gitHubPages);
    await this.page.getByRole("radio", { name: /^An organization/ }).click();
    await this.page.getByLabel("Organization name").fill(organization);
    await this.page.getByRole("button", { name: "Create the App on GitHub" }).click();
    const request = await posted;
    const manifest = new URLSearchParams(request.postData() ?? "").get("manifest") ?? "{}";
    return {
      url: new URL(request.url()),
      manifest: JSON.parse(manifest) as Record<string, unknown>,
    };
  }

  async expectOrganizationRequired() {
    await this.page.getByRole("radio", { name: /^An organization/ }).click();
    await this.page.getByRole("button", { name: "Create the App on GitHub" }).click();
    await expect(this.page.getByText("Enter the name of the organization.")).toBeVisible();
  }
}
