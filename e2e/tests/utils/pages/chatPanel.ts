import { expect, type Page } from "@playwright/test";

import { InboxItemPanel } from "./inboxItemPanel";

export class ChatPanel {
  constructor(private readonly page: Page) {}

  inboxItem(stepId: string) {
    return new InboxItemPanel(
      this.page
        .getByRole("region", { name: "Needs attention" })
        .getByRole("group", { name: stepId, exact: true }),
    );
  }

  async send(text: string) {
    await this.messageField.fill(text);
    await this.chat.getByRole("button", { name: "Send" }).click();
    return this;
  }

  async typeMessage(text: string) {
    await this.messageField.fill(text);
    return this;
  }

  async expectDraft(text: string) {
    await expect(this.messageField).toHaveValue(text);
    return this;
  }

  async expectAgentText(text: string) {
    await expect(this.chat.getByTestId("agent-text").filter({ hasText: text })).toBeVisible();
    return this;
  }

  private get messageField() {
    return this.chat.getByLabel("Message to the agent");
  }

  private get chat() {
    return this.page.getByRole("region", { name: "Transcript" });
  }
}
