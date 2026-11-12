import { expect, type Locator, type Page } from "@playwright/test";

import { RunPage } from "./runPage";
import { selectOption } from "./select";

export type StartRunOptions = { repo: string; workflow: string; inputs?: Record<string, string> };

export const startRunFrom = async (
  page: Page,
  newRunButton: Locator,
  { repo, workflow, inputs = {} }: StartRunOptions,
) => {
  await newRunButton.click();
  await selectOption(page, "Repo", repo);
  await selectOption(page, "Workflow", workflow);
  for (const [name, value] of Object.entries(inputs)) {
    await page.getByLabel(new RegExp(`^${name}( \\(required\\))?$`)).fill(value);
  }
  await page.getByRole("button", { name: "Start run" }).click();
  return RunPage.opened(page);
};

export class RunsPage {
  constructor(private readonly page: Page) {}

  async expectOpened() {
    await expect(this.page).toHaveURL(/\/runs$/);
  }

  async startRun(options: StartRunOptions) {
    const newRunButton = this.page.getByRole("main").getByRole("button", { name: "New run" });
    return startRunFrom(this.page, newRunButton, options);
  }
}
