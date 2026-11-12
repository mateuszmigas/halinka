import { expect, type Locator, type Page } from "@playwright/test";

export const rowWithCell = (page: Page, name: string) =>
  page.getByRole("row").filter({ has: page.getByRole("cell", { name, exact: true }) });

export const selectRowAction = async (page: Page, row: Locator, name: string, action: string) => {
  await row.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: action }).click();
};

export const confirmAction = async (page: Page, action: string) => {
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: action }).click();
  await expect(dialog).toBeHidden();
};
