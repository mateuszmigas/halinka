import type { Page } from "@playwright/test";

import { InboxItemPanel } from "./inboxItemPanel";
import { UpdateBanner } from "./updateBanner";

export class HomePage {
  constructor(private readonly page: Page) {}

  updateBanner() {
    return new UpdateBanner(this.page);
  }

  item(workflowRunId: number) {
    const runLink = this.page.getByRole("link", { name: new RegExp(`^#${workflowRunId} `) });
    return new InboxItemPanel(
      this.page
        .getByRole("region", { name: "Needs you" })
        .getByRole("article")
        .filter({ has: runLink }),
    );
  }
}
