import { z } from "zod";

import { type Agents, checkAgents } from "./agents";
import { branchNameHint, isBranchNameTemplate } from "./branchName";
import { isCronSchedule } from "./cron";
import { durationSchema } from "./duration";
import { issueActions, pullRequestActions } from "./eventFields";
import {
  canCheckReferences,
  checkCondition,
  checkReferences,
  checkTemplate,
} from "./expressionChecks";
import { singleExpression } from "./expressions";
import { identifierSchema } from "./identifier";
import { checkOutputNames } from "./implicitOutputs";
import { inputsSchema } from "./inputs";
import { canWrite, networkSchema, permissionsSchema } from "./permissions";
import { runnerLabelSchema } from "./runnerLabels";
import { parseVersioned } from "./schemaVersion";
import { outcomesSchema, outputsSchema, reportServerName } from "./stepReport";

const textSchema = z.string().refine((value) => value.trim() !== "", "Must not be empty");

const templateSchema = textSchema.superRefine(checkTemplate);

const branchNameSchema = templateSchema.refine(isBranchNameTemplate, branchNameHint);

const requiredConditionSchema = z.string().superRefine(checkCondition);

const conditionSchema = requiredConditionSchema.optional();

const scriptSchema = textSchema.refine((run) => !run.includes("${{"), "Do not use ${{ }} in run");

type Item = { path: (string | number)[]; item: unknown };

const fieldOf = (item: unknown, field: string) => (item as Record<string, unknown> | null)?.[field];

const ownItems = (items: unknown[]): Item[] =>
  items.map((item, index) => ({ path: [index], item }));

const withLoopChildren = (items: unknown[]): Item[] =>
  items.flatMap((item, index) => {
    const children = fieldOf(item, "steps");
    return [
      { path: [index], item },
      ...(Array.isArray(children)
        ? children.map((child, childIndex) => ({ path: [index, "steps", childIndex], item: child }))
        : []),
    ];
  });

const reportRepeated =
  (field: "id" | "name", term: string, itemsOf = ownItems) =>
  (items: unknown[], context: z.RefinementCtx) => {
    const seen = new Set<string>();
    for (const { path, item } of itemsOf(items)) {
      const value = fieldOf(item, field);
      if (typeof value !== "string") continue;
      if (seen.has(value)) {
        context.addIssue({
          code: "custom",
          path: [...path, field],
          message: `The ${term} "${value}" is already used`,
        });
      }
      seen.add(value);
    }
  };

const maxCostUsdSchema = z.number().positive("Use more than 0").optional();

const isArray = (payload: { value: unknown }) => Array.isArray(payload.value);

const shellStepSchema = z.strictObject({
  id: identifierSchema,
  type: z.literal("shell"),
  if: conditionSchema,
  run: scriptSchema,
  network: networkSchema.optional(),
  timeout: durationSchema.optional(),
});

export const gateFailActions = ["retry", "ask_human", "fail"] as const;

const exhaustedActions = ["ask_human", "fail"] as const;

const gateSchema = z.strictObject({
  name: identifierSchema,
  run: scriptSchema,
  network: networkSchema.optional(),
  on_fail: z.enum(gateFailActions).optional(),
});

const mcpServerSchema = z.strictObject({
  name: identifierSchema.refine((name) => name !== reportServerName, {
    message: `The name "${reportServerName}" is for the server of Halinka`,
  }),
  command: textSchema,
  args: z.array(z.string()).optional(),
});

const agentStepSchema = z
  .strictObject({
    id: identifierSchema,
    type: z.literal("agent"),
    if: conditionSchema,
    agent: textSchema,
    model: textSchema.optional(),
    prompt: templateSchema,
    permissions: permissionsSchema.optional(),
    tools: z.array(textSchema).optional(),
    mcp_servers: z
      .array(mcpServerSchema)
      .superRefine(reportRepeated("name", "server name"), { when: isArray })
      .optional(),
    require_changes: z.boolean().optional(),
    max_reminders: z.int().min(0, "Use 0 or more").optional(),
    max_attempts: z.int().min(1, "Use 1 or more").optional(),
    max_turns: z.int().min(1, "Use 1 or more").optional(),
    timeout: durationSchema.optional(),
    max_cost_usd: maxCostUsdSchema,
    on_exhausted: z.enum(exhaustedActions).optional(),
    gates: z
      .array(gateSchema)
      .superRefine(reportRepeated("name", "gate name"), { when: isArray })
      .optional(),
    outcomes: outcomesSchema.optional(),
    outputs: outputsSchema.superRefine(checkOutputNames).optional(),
  })
  .refine((step) => canWrite(step) || step.require_changes === undefined, {
    path: ["require_changes"],
    message: "Do not use require_changes with write: false",
  });

const approvalStepSchema = z.strictObject({
  id: identifierSchema,
  type: z.literal("approval"),
  if: conditionSchema,
  message: templateSchema,
  reviewers: z.array(identifierSchema).min(1, "Add at least one step").optional(),
});

const gitHubActions = ["open_pull_request", "comment_on_pull_request"] as const;

const gitHubStepSchema = z
  .strictObject({
    id: identifierSchema,
    type: z.literal("github"),
    if: conditionSchema,
    action: z.enum(gitHubActions),
    title: templateSchema.optional(),
    body: templateSchema.optional(),
    closes: templateSchema
      .refine((value) => singleExpression(value) !== undefined, "Use one ${{ }} and no other text")
      .optional(),
    timeout: durationSchema.optional(),
  })
  .refine((step) => step.action !== "comment_on_pull_request" || step.body !== undefined, {
    path: ["body"],
    message: "Add a body to comment_on_pull_request",
  })
  .refine((step) => step.action === "open_pull_request" || step.title === undefined, {
    path: ["title"],
    message: "Use title only with open_pull_request",
  })
  .refine((step) => step.action === "open_pull_request" || step.closes === undefined, {
    path: ["closes"],
    message: "Use closes only with open_pull_request",
  });

const stepUnion = <T extends readonly [z.ZodObject, ...z.ZodObject[]]>(schemas: T) => {
  const types = schemas.map((schema) => schema.shape.type.value).join(", ");
  return z.discriminatedUnion("type", schemas, {
    error: (issue) => (issue.code === "invalid_union" ? `Use a step type: ${types}` : undefined),
  });
};

const leafStepSchemas = [
  shellStepSchema,
  agentStepSchema,
  approvalStepSchema,
  gitHubStepSchema,
] as const;

const leafStepSchema = stepUnion(leafStepSchemas);

const loopStepSchema = z.strictObject({
  id: identifierSchema,
  type: z.literal("loop"),
  if: conditionSchema,
  max_iterations: z.int().min(1, "Use 1 or more"),
  until: requiredConditionSchema,
  max_cost_usd: maxCostUsdSchema,
  timeout: durationSchema.optional(),
  steps: z.array(leafStepSchema).min(1, "Add at least one step"),
});

const inputMappingSchema = z.record(identifierSchema, templateSchema);

const cronScheduleSchema = z
  .string()
  .refine(isCronSchedule, "Use five fields in UTC and a date that exists, for example 0 6 * * 1-5");

const triggersSchema = z.strictObject({
  issues: z
    .strictObject({
      types: z.array(z.enum(issueActions)).min(1, "Add at least one type"),
      labels: z.array(textSchema).min(1, "Add at least one label").optional(),
      inputs: inputMappingSchema.optional(),
    })
    .optional(),
  issue_comment: z
    .strictObject({ starts_with: textSchema, inputs: inputMappingSchema.optional() })
    .optional(),
  pull_request: z
    .strictObject({
      types: z.array(z.enum(pullRequestActions)).min(1, "Add at least one type"),
      labels: z.array(textSchema).min(1, "Add at least one label").optional(),
      inputs: inputMappingSchema.optional(),
    })
    .optional(),
  cron: z
    .strictObject({ schedule: cronScheduleSchema, inputs: inputMappingSchema.optional() })
    .optional(),
});

export type Triggers = z.infer<typeof triggersSchema>;

export const workflowSchema = z.strictObject({
  name: textSchema,
  inputs: inputsSchema.optional(),
  on: triggersSchema.optional(),
  branch: z.strictObject({ name: branchNameSchema }).optional(),
  // the labels that the runner of a run must have
  "runs-on": z.array(runnerLabelSchema).optional(),
  max_cost_usd: maxCostUsdSchema,
  concurrency: z
    .strictObject({ group: templateSchema, cancel_in_progress: z.boolean().optional() })
    .optional(),
  steps: z
    .array(stepUnion([...leafStepSchemas, loopStepSchema]))
    .min(1, "Add at least one step")
    .superRefine(reportRepeated("id", "step id", withLoopChildren), { when: isArray }),
});

export type Workflow = z.infer<typeof workflowSchema>;

export type LeafStep = z.infer<typeof leafStepSchema>;

export type LoopStep = z.infer<typeof loopStepSchema>;

export type Step = LeafStep | LoopStep;

export type ShellStep = Extract<LeafStep, { type: "shell" }>;

export type AgentStep = Extract<LeafStep, { type: "agent" }>;

export type ApprovalStep = Extract<LeafStep, { type: "approval" }>;

export type GitHubStep = Extract<LeafStep, { type: "github" }>;

const removedKeys = new Map([
  [
    "environment",
    "A workflow has no environment. config.yml names the devcontainer. Delete environment.",
  ],
  ["on_exhausted", "A loop has no on_exhausted. It fails at max_iterations. Delete on_exhausted."],
  [
    "with",
    "A github step has no with. Write title and body on the step. A pull request is not a draft and merges into the default branch.",
  ],
  ["base", "A branch has no base. A run starts from the default branch. Delete base."],
]);

// Without `agents`, the parse does not check the agents of the steps.
export const parseWorkflow = (source: string, { agents }: { agents?: Agents } = {}) =>
  parseVersioned(
    workflowSchema.superRefine(
      (workflow, context) => {
        checkReferences(workflow, context, agents);
        if (agents) checkAgents(workflow, context, agents);
      },
      { when: canCheckReferences },
    ),
    source,
    {
      removedKeys,
      olderMessage:
        "This file is from an older Halinka. Run halinka migrate --write, or click Apply fixes in the workflow editor.",
    },
  );
