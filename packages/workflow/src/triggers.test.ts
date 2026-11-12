import { describe, expect, it } from "vitest";

import { type GitHubEvent, gitHubEventSchema, triggerInputs } from "./triggers";
import { parseWorkflow, type Triggers } from "./workflow";

const triggersOf = (on: string[]) => {
  const source = [
    "schema_version: 1",
    "name: Fix",
    "inputs:",
    "  issue_number: { type: number, required: true }",
    "  text: { type: string, default: none }",
    "on:",
    ...on,
    "steps:",
    "  - id: build",
    "    type: shell",
    "    run: ls",
  ];
  const result = parseWorkflow(source.join("\n"));
  if (!result.ok) throw new Error(result.problems[0]!.message);
  return result.value.on as Triggers;
};

const issues = (filter: string[], ...mapping: string[]) =>
  triggersOf([
    "  issues:",
    ...filter,
    "    inputs:",
    "      issue_number: ${{ event.issue.number }}",
    ...mapping.map((line) => `      ${line}`),
  ]);

const opened = ["    types: [opened]"];

const comments = triggersOf([
  "  issue_comment:",
  "    starts_with: /halinka",
  "    inputs:",
  "      issue_number: ${{ event.issue.number }}",
  "      text: ${{ event.comment.body }}",
]);

const actor = { login: "octo" };

const delivered = { sender: { ...actor, id: 1 }, repository: { id: 100 } };

const issue = {
  number: 7,
  title: "Broken",
  body: null,
  html_url: "https://github.test/7",
  user: actor,
  labels: [{ name: "bug" }],
};

const issueEvent = (action: string, label?: string): GitHubEvent => ({
  name: "issues",
  data: { action, issue, ...delivered, ...(label && { label: { name: label } }) },
});

const commentEvent = (body: string, action = "created", pullRequest?: object): GitHubEvent => ({
  name: "issue_comment",
  data: {
    action,
    issue: { ...issue, ...(pullRequest && { pull_request: pullRequest }) },
    comment: { body, html_url: "https://github.test/7#1", user: actor },
    ...delivered,
  },
});

describe("triggers", () => {
  it("gives nothing to a workflow with no trigger", () => {
    expect(triggerInputs(undefined, issueEvent("opened"))).toBeUndefined();
  });

  it("keeps the type of a value that is one expression", () => {
    expect(triggerInputs(issues(opened), issueEvent("opened"))).toEqual({ issue_number: 7 });
  });

  it("keeps the type when spaces surround the expression", () => {
    const on = triggersOf([
      "  issues:",
      ...opened,
      "    inputs:",
      "      issue_number: ' ${{ event.issue.number }} '",
    ]);

    expect(triggerInputs(on, issueEvent("opened"))).toEqual({ issue_number: 7 });
  });

  it("makes text of a value with text around the expression", () => {
    const on = issues(opened, "text: 'Fix #${{ event.issue.number }}'");

    expect(triggerInputs(on, issueEvent("opened"))?.text).toBe("Fix #7");
  });

  it("makes text of two expressions with nothing between them", () => {
    const on = issues(opened, "text: ${{ event.issue.number }}${{ event.issue.title }}");

    expect(triggerInputs(on, issueEvent("opened"))?.text).toBe("7Broken");
  });

  it("uses the default of a value that the event does not have", () => {
    const on = issues(opened, "text: ${{ event.issue.body ?? 'empty' }}");

    expect(triggerInputs(on, issueEvent("opened"))?.text).toBe("empty");
  });

  it("gives an empty text for a null default", () => {
    const on = issues(opened, "text: ${{ event.issue.body ?? null }}");

    expect(triggerInputs(on, issueEvent("opened"))?.text).toBe("");
  });

  it("gives a constant as it is", () => {
    const on = issues(opened, "text: fixed");

    expect(triggerInputs(on, issueEvent("opened"))?.text).toBe("fixed");
  });

  it("ignores an action that is not in the types", () => {
    expect(triggerInputs(issues(opened), issueEvent("reopened"))).toBeUndefined();
  });

  it("starts for the label that the action added", () => {
    const on = issues(["    types: [labeled]", "    labels: [halinka]"]);

    expect(triggerInputs(on, issueEvent("labeled", "halinka"))).toBeDefined();
  });

  it("ignores another label that the action added, when the issue has a listed label", () => {
    const on = issues(["    types: [labeled]", "    labels: [bug]"]);

    expect(triggerInputs(on, issueEvent("labeled", "other"))).toBeUndefined();
  });

  it("starts for a label of the issue on another action", () => {
    const on = issues([...opened, "    labels: [bug]"]);

    expect(triggerInputs(on, issueEvent("opened"))).toBeDefined();
  });

  it("ignores an issue with no listed label", () => {
    const on = issues([...opened, "    labels: [halinka]"]);

    expect(triggerInputs(on, issueEvent("opened"))).toBeUndefined();
  });

  it("maps a new comment that starts with the text", () => {
    expect(triggerInputs(comments, commentEvent("/halinka fix it"))).toEqual({
      issue_number: 7,
      text: "/halinka fix it",
    });
  });

  it("ignores a comment that does not start with the text", () => {
    expect(triggerInputs(comments, commentEvent("see /halinka"))).toBeUndefined();
  });

  it("ignores an edited comment", () => {
    expect(triggerInputs(comments, commentEvent("/halinka", "edited"))).toBeUndefined();
  });

  it("ignores a comment on a pull request", () => {
    const event = commentEvent("/halinka", "created", { url: "https://github.test/pr/7" });

    expect(triggerInputs(comments, event)).toBeUndefined();
  });

  const head = { ref: "fix/7", sha: "a".repeat(40), repo: { id: 100 } };
  const pullRequest = {
    number: 7,
    state: "open",
    title: "Fix",
    body: null,
    html_url: "https://github.test/pull/7",
    user: actor,
    draft: false,
    labels: [{ name: "review" }],
    head,
    base: { ref: "main" },
  };
  const eventOf = (action: string, fields: object = {}, label?: string): GitHubEvent => ({
    name: "pull_request",
    data: {
      action,
      pull_request: { ...pullRequest, ...fields },
      ...delivered,
      repository: { id: 100, default_branch: "main" },
      ...(label && { label: { name: label } }),
    },
  });
  const onOf = (lines: string[] = ["    types: [opened, labeled]"]) =>
    triggersOf([
      "  pull_request:",
      ...lines,
      "    inputs:",
      "      issue_number: ${{ event.pull_request.number }}",
    ]);

  it("maps the fields of the pull request", () => {
    expect(triggerInputs(onOf(), eventOf("opened"))).toEqual({ issue_number: 7 });
  });

  it("starts for a draft", () => {
    expect(triggerInputs(onOf(), eventOf("opened", { draft: true }))).toBeDefined();
  });

  it("does not start for another action", () => {
    expect(triggerInputs(onOf(), eventOf("synchronize"))).toBeUndefined();
  });

  it("does not start for a label on a closed pull request", () => {
    expect(triggerInputs(onOf(), eventOf("labeled", { state: "closed" }))).toBeUndefined();
  });

  it("does not start for a pull request into another branch", () => {
    expect(
      triggerInputs(onOf(), eventOf("opened", { base: { ref: "release/1" } })),
    ).toBeUndefined();
  });

  it("does not start for a fork", () => {
    const fork = { head: { ...head, repo: { id: 999 } } };

    expect(triggerInputs(onOf(), eventOf("opened", fork))).toBeUndefined();
  });

  it("does not start for a fork that its owner deleted", () => {
    const deleted = { head: { ...head, repo: null } };

    expect(triggerInputs(onOf(), eventOf("opened", deleted))).toBeUndefined();
  });

  it("reads the added label for a labeled action", () => {
    const on = onOf(["    types: [labeled]", "    labels: [ship]"]);

    expect(triggerInputs(on, eventOf("labeled", {}, "review"))).toBeUndefined();
    expect(triggerInputs(on, eventOf("labeled", {}, "ship"))).toBeDefined();
  });

  it("reads the labels of the pull request for another action", () => {
    const on = onOf(["    types: [opened]", "    labels: [review]"]);

    expect(triggerInputs(on, eventOf("opened"))).toBeDefined();
  });

  const body = { ...issueEvent("opened").data, extra: "field" };

  it("keeps only the fields of the schema", () => {
    const { data } = gitHubEventSchema.parse({ name: "issues", data: body });

    expect(data).not.toHaveProperty("extra");
  });

  it("gives no labels to an issue that has no list", () => {
    const { labels: _labels, ...withoutLabels } = issue;

    const event = gitHubEventSchema.parse({
      name: "issues",
      data: { ...body, issue: withoutLabels },
    });

    expect(event.name === "issues" && event.data.issue.labels).toEqual([]);
  });

  it("takes an issue with no user", () => {
    const data = { ...body, issue: { ...issue, user: null } };

    expect(gitHubEventSchema.safeParse({ name: "issues", data }).success).toBe(true);
  });

  it("refuses a body of another shape", () => {
    expect(gitHubEventSchema.safeParse({ name: "issues", data: {} }).success).toBe(false);
  });
});
