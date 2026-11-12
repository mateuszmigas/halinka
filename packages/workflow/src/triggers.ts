import { z } from "zod";

import { evaluateValue } from "./expressions";
import type { Inputs } from "./inputs";
import type { Triggers } from "./workflow";

const actorSchema = z.object({ login: z.string() });

const labelSchema = z.object({ name: z.string() });

const issueFields = {
  action: z.string(),
  issue: z.object({
    number: z.number(),
    title: z.string(),
    body: z.string().nullable(),
    html_url: z.string(),
    user: actorSchema.nullable(),
    labels: z.array(labelSchema).default([]),
    pull_request: z.unknown().optional(),
  }),
  sender: actorSchema.extend({ id: z.number() }),
  repository: z.object({ id: z.number() }),
};

const pullRequestEventSchema = z.object({
  name: z.literal("pull_request"),
  data: z.object({
    action: z.string(),
    pull_request: z.object({
      number: z.number(),
      state: z.string(),
      title: z.string(),
      body: z.string().nullable(),
      html_url: z.string(),
      user: actorSchema.nullable(),
      draft: z.boolean().default(false),
      labels: z.array(labelSchema).default([]),
      head: z.object({
        ref: z.string(),
        sha: z.string().regex(/^[0-9a-f]{40}$/),
        // null: a fork that its owner deleted
        repo: z.object({ id: z.number() }).nullable(),
      }),
      base: z.object({ ref: z.string() }),
    }),
    label: labelSchema.optional(),
    sender: issueFields.sender,
    repository: z.object({ id: z.number(), default_branch: z.string() }),
  }),
});

export const gitHubEventSchema = z.discriminatedUnion("name", [
  pullRequestEventSchema,
  z.object({
    name: z.literal("issues"),
    data: z.object({ ...issueFields, label: labelSchema.optional() }),
  }),
  z.object({
    name: z.literal("issue_comment"),
    data: z.object({
      ...issueFields,
      comment: z.object({ body: z.string(), html_url: z.string(), user: actorSchema.nullable() }),
    }),
  }),
]);

export type GitHubEvent = z.infer<typeof gitHubEventSchema>;

const mapInputs = (event: object, mapping: Record<string, string> = {}): Inputs =>
  Object.fromEntries(
    Object.entries(mapping).map(([name, template]) => [
      name,
      evaluateValue(template, { inputs: {}, steps: {}, event }),
    ]),
  );

const hasLabel = (
  labels: string[],
  { action, label }: { action: string; label?: { name: string } | undefined },
  current: { name: string }[],
) =>
  action === "labeled"
    ? labels.includes(label?.name ?? "")
    : current.some(({ name }) => labels.includes(name));

type PullRequestEvent = Extract<GitHubEvent, { name: "pull_request" }>;

const isFromThisRepo = ({ data }: PullRequestEvent) =>
  data.pull_request.head.repo?.id === data.repository.id;

const pullRequestInputs = (
  on: Triggers | undefined,
  event: PullRequestEvent,
): Inputs | undefined => {
  const trigger = on?.pull_request;
  const { data } = event;
  if (!trigger?.types.some((type) => type === data.action)) return undefined;
  if (data.pull_request.state !== "open" || !isFromThisRepo(event)) return undefined;
  // The run has the definition and the base of the default branch.
  if (data.pull_request.base.ref !== data.repository.default_branch) return undefined;
  if (trigger.labels && !hasLabel(trigger.labels, data, data.pull_request.labels)) return undefined;
  return mapInputs(data, trigger.inputs);
};

export const cronInputs = (on: Triggers | undefined): Inputs => mapInputs({}, on?.cron?.inputs);

// undefined: the workflow does not start for this event
export const triggerInputs = (on: Triggers | undefined, event: GitHubEvent): Inputs | undefined => {
  if (event.name === "pull_request") return pullRequestInputs(on, event);
  if (event.name === "issues") {
    const trigger = on?.issues;
    if (!trigger?.types.some((type) => type === event.data.action)) return undefined;
    if (trigger.labels && !hasLabel(trigger.labels, event.data, event.data.issue.labels)) {
      return undefined;
    }
    return mapInputs(event.data, trigger.inputs);
  }
  const trigger = on?.issue_comment;
  const { action, comment, issue } = event.data;
  if (!trigger || action !== "created" || issue.pull_request !== undefined) return undefined;
  if (!comment.body.startsWith(trigger.starts_with)) return undefined;
  return mapInputs(event.data, trigger.inputs);
};
