import type { Page } from "@playwright/test";

import { InboxItemPanel } from "./inboxItemPanel";
import { rowWithCell } from "./rows";

export class InboxPage {
  constructor(private readonly page: Page) {}

  item(workflowRunId: number, stepId: string) {
    const runLink = this.page.getByRole("link", { name: `#${workflowRunId}`, exact: true });
    return new InboxItemPanel(rowWithCell(this.page, stepId).filter({ has: runLink }));
  }
}
