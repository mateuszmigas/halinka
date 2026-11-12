import type { InboxItemDecision } from "@halinka/server/client";

export const decisionLabels: Record<InboxItemDecision, { action: string; done: string }> = {
  approve: { action: "Approve", done: "Approved" },
  reject: { action: "Reject", done: "Rejected" },
  retry: { action: "Try again", done: "Tried again" },
  accept: { action: "Accept", done: "Accepted" },
  fail: { action: "Fail", done: "Failed" },
  continue: { action: "Continue", done: "Continued" },
  answered: { action: "Answer", done: "Answered" },
};
