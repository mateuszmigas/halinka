import type { OutputFields } from "./stepReport";

export const issueActions = ["opened", "reopened", "labeled"] as const;

export const pullRequestActions = ["opened", "reopened", "synchronize", "labeled"] as const;

const actor = { login: "string" } satisfies OutputFields;

const issue = {
  number: "number",
  title: "string",
  body: "string",
  html_url: "string",
  user: actor,
} satisfies OutputFields;

const comment = { body: "string", html_url: "string", user: actor } satisfies OutputFields;

const pullRequest = {
  number: "number",
  title: "string",
  body: "string",
  html_url: "string",
  user: actor,
  draft: "boolean",
  head: { ref: "string", sha: "string" },
  base: { ref: "string" },
} satisfies OutputFields;

export const eventFields = {
  issues: { issue, sender: actor },
  issue_comment: { issue, comment, sender: actor },
  pull_request: { pull_request: pullRequest, sender: actor },
  cron: {},
} satisfies Record<string, OutputFields>;

export const nullableEventPaths = ["event.issue.body", "event.pull_request.body"];
