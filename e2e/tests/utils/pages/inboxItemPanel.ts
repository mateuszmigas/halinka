import { expect, type Locator } from "@playwright/test";

export class InboxItemPanel {
  constructor(private readonly item: Locator) {}

  async approve() {
    await this.submit("Approve");
    return this;
  }

  async answer(option: string) {
    await this.item.getByRole("radio", { name: option }).check();
    await this.submit("Answer");
    return this;
  }

  async answerOther(text: string) {
    await this.item.getByLabel("Other", { exact: true }).fill(text);
    await this.submit("Answer");
    return this;
  }

  private async submit(name: string) {
    const button = this.item.getByRole("button", { name });
    await button.click();
    // The portal removes the button after it stores the decision.
    await expect(button).toBeHidden();
  }
}
