import {
  agentTestStatuses,
  type AgentAnswer,
  agentAnswerSchema,
  type AgentQuestions,
  attemptStatuses,
  buildSchema,
  decisionItemDecisions,
  decisionItemKinds,
  inboxItemDecisions,
  repoKinds,
  runnerStates,
  runnerUpdateRequests,
  type RunEvent,
  runStatuses,
  sandboxAttachSchema,
  sandboxKinds,
  sandboxSpecs,
  sandboxStates,
  stepRunStatuses,
} from "@halinka/protocol";
import { maxFileMib, mib } from "@halinka/utils/repoFiles";
import { secretNameSchema, type Workflow, type WorkflowInput } from "@halinka/workflow";
import { type AnySchema, type ErrorMapItem, eventIterator, oc } from "@orpc/contract";
import { z } from "zod";

import type { ServiceErrorCode } from "../services/serviceError";

const problemSchema = z.object({
  line: z.number(),
  column: z.number(),
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});

const issueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])).optional(),
  message: z.string(),
});

export const apiErrors = {
  // data only for an input that does not match the input schema
  BAD_REQUEST: { status: 400, data: z.object({ issues: z.array(issueSchema) }).optional() },
  NOT_FOUND: { status: 404 },
  CONFLICT: { status: 409 },
  INVALID_WORKFLOW: {
    status: 400,
    data: z.object({ path: z.string(), problems: z.array(problemSchema) }),
  },
  // the repo's `.halinka/` cannot be read or written: too large, or no permission
  INVALID_DEFINITIONS: { status: 422 },
  RUNNER_OFFLINE: { status: 503 },
  // `repos.init` writes the missing `.halinka/config.yml`; `devcontainers`: from the repo root
  REPO_NOT_SET_UP: { status: 400, data: z.object({ devcontainers: z.array(z.string()) }) },
} satisfies Record<ServiceErrorCode, ErrorMapItem<AnySchema>>;

const errors = <T extends ServiceErrorCode>(...codes: T[]) =>
  Object.fromEntries(codes.map((code) => [code, apiErrors[code]])) as Pick<typeof apiErrors, T>;

const repoSchema = z.object({
  id: z.number(),
  kind: z.enum(repoKinds),
  name: z.string(),
  // undefined: a `github` repo
  path: z.string().optional(),
  runnerId: z.number().optional(),
  githubRepoId: z.number().optional(),
});

const folderSchema = z.object({ name: z.string(), path: z.string(), isRepo: z.boolean() });

const folderListingSchema = z.object({
  path: z.string(),
  parent: z.string().optional(),
  isRepo: z.boolean(),
  folders: z.array(folderSchema),
  isTruncated: z.boolean(),
});

const runnerSchema = z.object({
  id: z.number(),
  name: z.string(),
  publicKey: z.string().optional(),
  state: z.enum(runnerStates),
  labels: z.array(z.string()),
  // undefined: every agent
  allowedAgents: z.array(z.string()).optional(),
  os: z.string().optional(),
  arch: z.string().optional(),
  sandboxKind: z.enum(["devcontainer", "worktree"]).optional(),
  version: z.string().optional(),
  buildId: z.string().optional(),
  // runs under its service unit with self-update on
  canUpdate: z.boolean(),
  hasAutoUpdate: z.boolean(),
  updateRequest: z.enum(runnerUpdateRequests).optional(),
  updateFailure: z.string().optional(),
  heldRunIds: z.array(z.number()),
  // `outdated`: the runner runs another build than the server
  buildStatus: z.enum(["current", "outdated", "update_needed"]).optional(),
  isConnected: z.boolean(),
  lastSeenAt: z.date().optional(),
});

const adminRunnerSchema = runnerSchema.omit({
  isConnected: true,
  publicKey: true,
  heldRunIds: true,
});

const runnerNameSchema = z.string().trim().min(1, "Enter a name").max(100);

const runnerSettingsShape = {
  labels: z.array(z.string()),
  allowedAgents: z.array(z.string()).nullable(),
};

// The key checks are in the service: they need `node:crypto`, and the portal bundles this file.
const signedRegistrationSchema = z.object({
  publicKey: z.string(),
  signature: z.string(),
  name: runnerNameSchema,
  os: z.string().max(100),
  arch: z.string().max(100),
});

// The fields of each call that a runner signs before it connects.
const signedCallSchema = z.object({
  publicKey: z.string().max(100),
  signature: z.string().max(200),
  serverUrl: z.string().max(2000),
  sentAt: z.number().int(),
});

const signedProbeSchema = signedCallSchema.extend({
  protocolVersion: z.number().int(),
  build: buildSchema,
});

const userCodeSchema = z
  .string()
  .trim()
  .transform((code) => code.toUpperCase());

const runnerRequestSchema = z.object({
  userCode: z.string(),
  hostName: z.string().optional(),
  os: z.string().optional(),
  arch: z.string().optional(),
  expiresAt: z.date(),
});

// `name` and `inputs` are undefined when the file is not a valid workflow
const workflowFileSchema = z.object({
  path: z.string(),
  name: z.string().optional(),
  inputs: z.record(z.string(), z.custom<WorkflowInput>()).optional(),
  problems: z.array(problemSchema),
});

const workflowListSchema = z.object({
  configProblems: z.array(problemSchema),
  workflows: z.array(workflowFileSchema),
});

const workflowSchema = z.object({
  path: z.string(),
  source: z.string(),
  // send it to `writeWorkflow` to replace the file
  hash: z.string(),
  workflow: z.custom<Workflow>().optional(),
  problems: z.array(problemSchema),
});

const runSchema = z.object({ id: z.number(), status: z.enum(runStatuses) });

const idInputSchema = z.object({ id: z.number().int().positive() });

const deletionSchema = z.object({
  id: z.number(),
  // false: the row goes after the runner removes what it holds
  isDeleted: z.boolean(),
});

const stepRunSchema = z.object({
  id: z.number(),
  stepId: z.string(),
  status: z.enum(stepRunStatuses),
  summary: z.string().optional(),
  outcome: z.string().optional(),
  outputs: z.record(z.string(), z.unknown()).optional(),
  parentStepRunId: z.number().optional(),
  iteration: z.number().optional(),
  usage: z.object({ costUsd: z.number() }).optional(),
  startedAt: z.date(),
  finishedAt: z.date().optional(),
});

const attemptSchema = z.object({
  id: z.number(),
  stepRunId: z.number(),
  attempt: z.number(),
  status: z.enum(attemptStatuses),
  exitCode: z.number().optional(),
  commitBefore: z.string().optional(),
  commitAfter: z.string().optional(),
  startedAt: z.date(),
  finishedAt: z.date().optional(),
});

const runLabelSchema = z.object({
  repoName: z.string(),
  workflowPath: z.string(),
  workflowName: z.string(),
});

const runPageSize = 50;

export const maxRunPageSize = 200;

const runSummarySchema = runSchema.extend({
  ...runLabelSchema.shape,
  repoId: z.number(),
  branch: z.string(),
  createdAt: z.date(),
  startedAt: z.date().optional(),
  finishedAt: z.date().optional(),
});

const inboxItemSchema = <Shape extends z.ZodRawShape>(shape: Shape) => {
  const fields = {
    id: z.number(),
    workflowRunId: z.number(),
    stepRunId: z.number(),
    resolvedBy: z.string().optional(),
    resolvedAt: z.date().optional(),
    createdAt: z.date(),
    ...shape,
  };
  return z.discriminatedUnion("kind", [
    z.object({
      ...fields,
      kind: z.enum(decisionItemKinds),
      message: z.string(),
      decision: z.enum(inboxItemDecisions).optional(),
      note: z.string().optional(),
    }),
    z.object({
      ...fields,
      kind: z.literal("question"),
      questions: z.custom<AgentQuestions>(),
      answer: z.custom<AgentAnswer>().optional(),
    }),
  ]);
};

const stepShape = { stepId: z.string() };

const agentMessageSchema = z.object({
  id: z.number(),
  stepRunId: z.number(),
  text: z.string(),
  author: z.string(),
  createdAt: z.date(),
});

const runDetailSchema = runSummarySchema.extend({
  baseSha: z.string(),
  cancelRequestedAt: z.date().optional(),
  error: z.string().optional(),
  pushedCommit: z.string().optional(),
  pullRequestUrl: z.string().optional(),
  // the test of a draft
  isTestRun: z.boolean(),
  isSetupSkipped: z.boolean(),
  canPush: z.boolean(),
  canOpenPullRequest: z.boolean(),
  // none when the run is not queued or the runner can take it
  waitReason: z.string().optional(),
  canCancel: z.boolean(),
  canDelete: z.boolean(),
  sandbox: z
    .object({
      kind: z.enum(sandboxKinds),
      spec: z.enum(sandboxSpecs),
      observed: z.enum(sandboxStates).optional(),
      // the engine of the run owns the sandbox
      isInUse: z.boolean(),
      // the runner did not apply `spec` yet
      isPending: z.boolean(),
      error: z.string().optional(),
      // only when the local runner runs the container of an ended or expired run
      attach: sandboxAttachSchema.optional(),
      // only when another runner runs the container of an ended or expired run
      sshFolder: z.string().optional(),
    })
    .optional(),
  canRemoveSandbox: z.boolean(),
  canStartSandbox: z.boolean(),
  canStopSandbox: z.boolean(),
  // checked at run creation; a later, stricter schema must not refuse old runs
  workflow: z.custom<Workflow>(),
  stepRuns: z.array(stepRunSchema),
  attempts: z.array(attemptSchema),
  inboxItems: z.array(inboxItemSchema(stepShape)),
  // the running agent step run that takes a message, and the decision it gives a pending item
  messageTarget: z
    .object({ stepRunId: z.number(), decision: z.enum(decisionItemDecisions).optional() })
    .optional(),
  // the finished agent step runs that a message reopens
  reopenTargets: z.array(z.number()),
  // the failed `github` step runs that `retryStep` reopens
  retryTargets: z.array(z.number()),
  // a delivered message is in the `agent_prompt` event that carried it
  undeliveredMessages: z.array(agentMessageSchema),
});

const runEventsInputSchema = idInputSchema.extend({
  after: z.number().int().nonnegative().default(0),
});

const storedRunEventSchema = z.object({
  seq: z.number(),
  createdAt: z.date(),
  // a later, stricter union must not refuse old events
  event: z.custom<RunEvent>(),
});

const runChangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("events"), events: z.array(storedRunEventSchema) }),
  // the run's status, step runs or attempts changed: read `runs.get` again
  z.object({ type: z.literal("state") }),
]);

const memberSchema = z.object({
  id: z.number(),
  login: z.string(),
  role: z.enum(["admin", "member"]),
  createdAt: z.date(),
});

const gitHubAppSchema = z.object({
  slug: z.string(),
  ownerLogin: z.string(),
  isReadable: z.boolean(),
  installUrl: z.string(),
});

const gitHubStatusSchema = z.object({
  app: gitHubAppSchema.optional(),
  installations: z.array(
    z.object({
      githubId: z.number(),
      accountLogin: z.string(),
      isSuspended: z.boolean(),
      repos: z.array(z.object({ githubId: z.number(), owner: z.string(), name: z.string() })),
    }),
  ),
});

const agentKeysAndTestsSchema = z.object({
  credentials: z.array(
    z.object({ variable: z.string(), state: z.enum(["set", "unreadable", "not_set"]) }),
  ),
  tests: z.array(
    z.object({
      runner: z.string(),
      status: z.enum(agentTestStatuses),
      capabilities: z.record(z.string(), z.unknown()).optional(),
      error: z.string().optional(),
      isOutdated: z.boolean(),
    }),
  ),
});

const agentSchema = agentKeysAndTestsSchema.extend({
  preset: z.string(),
  label: z.string(),
  isEnabled: z.boolean(),
  version: z.string().optional(),
  defaultVersion: z.string(),
  model: z.string().optional(),
  // undefined on a server without a login
  mine: agentKeysAndTestsSchema.optional(),
});

const agentCredentialInputSchema = z.object({ preset: z.string(), variable: z.string() });

const agentTestInputSchema = z.object({ preset: z.string(), runner: z.string() });

// Long enough to mask, and valid in an HTTP header and an env file.
const secretValueSchema = z
  .string()
  .trim()
  .regex(/^[\x21-\x7e]{8,4096}$/, "Use 8 to 4096 characters, with no spaces");

const repoSecretInputSchema = idInputSchema.extend({ name: secretNameSchema });

// `isUpdateCheckOn`: the server reads the latest version from the npm registry.
const serverSettingsSchema = z.object({ isUpdateCheckOn: z.boolean() });

export const contract = {
  health: oc.route({ method: "GET", path: "/health" }).output(z.object({ ok: z.literal(true) })),
  session: oc.route({ method: "GET", path: "/session" }).output(
    z.object({
      isLoginRequired: z.boolean(),
      serverUrl: z.string(),
      user: memberSchema.pick({ login: true, role: true }).optional(),
    }),
  ),
  cliLogin: {
    start: oc
      .route({ method: "POST", path: "/cli-logins", successStatus: 201 })
      .errors(errors("BAD_REQUEST"))
      .output(z.object({ deviceCode: z.string(), userCode: z.string(), expiresAt: z.date() })),
    exchange: oc
      .route({ method: "POST", path: "/cli-logins/exchange" })
      .errors(errors("BAD_REQUEST"))
      .input(z.object({ deviceCode: z.string().min(1) }))
      .output(
        z.discriminatedUnion("status", [
          z.object({ status: z.literal("pending") }),
          z.object({ status: z.literal("approved"), token: z.string() }),
        ]),
      ),
    list: oc
      .route({ method: "GET", path: "/cli-logins" })
      .output(z.array(z.object({ id: z.number(), createdAt: z.date(), expiresAt: z.date() }))),
    end: oc
      .route({ method: "DELETE", path: "/cli-logins/{id}" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND"))
      .input(idInputSchema)
      .output(z.object({ id: z.number() })),
    // the login of the token that the request sends
    logout: oc
      .route({ method: "POST", path: "/cli-logins/logout" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND"))
      .output(z.object({ id: z.number() })),
    approve: oc
      .route({ method: "POST", path: "/cli-logins/{userCode}/approve" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND"))
      .input(z.object({ userCode: z.string().min(1) }))
      .output(z.object({ userCode: z.string() })),
  },
  agents: {
    list: oc.route({ method: "GET", path: "/agents" }).output(z.array(agentSchema)),
    update: oc
      .route({ method: "PATCH", path: "/agents/{preset}" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND"))
      .input(
        z.object({
          preset: z.string(),
          isEnabled: z.boolean().optional(),
          // It goes into `npm install`.
          version: z
            .string()
            .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "Use an exact version, such as 1.2.3")
            .nullable()
            .optional(),
          model: z.string().trim().min(1).max(200).nullable().optional(),
        }),
      )
      .output(z.object({ preset: z.string() })),
    setCredential: oc
      .route({ method: "PUT", path: "/agents/{preset}/credentials/{variable}" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND"))
      .input(agentCredentialInputSchema.extend({ value: secretValueSchema }))
      .output(z.object({ preset: z.string() })),
    deleteCredential: oc
      .route({ method: "DELETE", path: "/agents/{preset}/credentials/{variable}" })
      .errors(errors("NOT_FOUND"))
      .input(agentCredentialInputSchema)
      .output(z.object({ preset: z.string() })),
    test: oc
      .route({ method: "POST", path: "/agents/{preset}/tests" })
      .errors(errors("NOT_FOUND", "CONFLICT", "RUNNER_OFFLINE"))
      .input(agentTestInputSchema)
      .output(z.object({ preset: z.string() })),
    setMyCredential: oc
      .route({ method: "PUT", path: "/agents/{preset}/my-credentials/{variable}" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND"))
      .input(agentCredentialInputSchema.extend({ value: secretValueSchema }))
      .output(z.object({ preset: z.string() })),
    deleteMyCredential: oc
      .route({ method: "DELETE", path: "/agents/{preset}/my-credentials/{variable}" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND"))
      .input(agentCredentialInputSchema)
      .output(z.object({ preset: z.string() })),
    testMine: oc
      .route({ method: "POST", path: "/agents/{preset}/my-tests" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND", "CONFLICT", "RUNNER_OFFLINE"))
      .input(agentTestInputSchema)
      .output(z.object({ preset: z.string() })),
  },
  github: {
    status: oc.route({ method: "GET", path: "/github/app" }).output(gitHubStatusSchema),
    manifest: oc
      .route({ method: "POST", path: "/github/app/manifest" })
      .errors(errors("BAD_REQUEST", "CONFLICT"))
      .input(
        z.object({
          organization: z
            .string()
            .regex(/^[a-zA-Z0-9-]+$/)
            .optional(),
        }),
      )
      .output(z.object({ url: z.string(), manifest: z.string() })),
    connect: oc
      .route({ method: "POST", path: "/github/app" })
      .errors(errors("BAD_REQUEST", "CONFLICT"))
      .input(z.object({ code: z.string().min(1), state: z.string().min(1) }))
      .output(gitHubAppSchema),
    disconnect: oc
      .route({ method: "DELETE", path: "/github/app" })
      .errors(errors("NOT_FOUND"))
      .output(z.object({ slug: z.string() })),
    refresh: oc
      .route({ method: "POST", path: "/github/app/refresh" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND", "CONFLICT"))
      .output(gitHubStatusSchema),
  },
  members: {
    list: oc.route({ method: "GET", path: "/members" }).output(z.array(memberSchema)),
    create: oc
      .route({ method: "POST", path: "/members" })
      .errors(errors("BAD_REQUEST", "CONFLICT"))
      .input(
        z.object({ login: z.string().regex(/^[a-zA-Z0-9-]+$/), role: memberSchema.shape.role }),
      )
      .output(memberSchema),
    delete: oc
      .route({ method: "DELETE", path: "/members/{id}" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND", "CONFLICT"))
      .input(idInputSchema)
      .output(z.object({ id: z.number() })),
  },
  serverSettings: {
    get: oc.route({ method: "GET", path: "/server-settings" }).output(serverSettingsSchema),
    update: oc
      .route({ method: "PATCH", path: "/server-settings" })
      .errors(errors("BAD_REQUEST"))
      .input(serverSettingsSchema.partial())
      .output(serverSettingsSchema),
  },
  repos: {
    list: oc.route({ method: "GET", path: "/repos" }).output(z.array(repoSchema)),
    secrets: oc
      .route({ method: "GET", path: "/repos/{id}/secrets" })
      .errors(errors("NOT_FOUND"))
      .input(idInputSchema)
      .output(z.array(z.object({ name: z.string(), isReadable: z.boolean() }))),
    setSecret: oc
      .route({ method: "PUT", path: "/repos/{id}/secrets/{name}" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND"))
      .input(repoSecretInputSchema.extend({ value: secretValueSchema }))
      .output(z.object({ name: z.string() })),
    deleteSecret: oc
      .route({ method: "DELETE", path: "/repos/{id}/secrets/{name}" })
      .errors(errors("NOT_FOUND"))
      .input(repoSecretInputSchema)
      .output(z.object({ name: z.string() })),
    register: oc
      .route({ method: "POST", path: "/repos" })
      .errors(
        errors(
          "BAD_REQUEST",
          "NOT_FOUND",
          "CONFLICT",
          "INVALID_DEFINITIONS",
          "RUNNER_OFFLINE",
          "REPO_NOT_SET_UP",
        ),
      )
      .input(
        z.object({
          runnerId: z.number().int().positive(),
          path: z.string().startsWith("/", "Use an absolute path"),
        }),
      )
      .output(repoSchema),
    createGitHub: oc
      .route({ method: "POST", path: "/repos/github" })
      .errors(errors("BAD_REQUEST", "CONFLICT"))
      .input(z.object({ githubRepoId: z.number().int().positive() }))
      .output(repoSchema),
    linkGitHub: oc
      .route({ method: "PUT", path: "/repos/{id}/github" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND"))
      .input(idInputSchema.extend({ githubRepoId: z.number().int().positive().nullable() }))
      .output(repoSchema),
    // Writes the scaffold of `halinka init`, then registers the repo.
    init: oc
      .route({ method: "POST", path: "/repos/init" })
      .errors(
        errors(
          "BAD_REQUEST",
          "NOT_FOUND",
          "CONFLICT",
          "INVALID_DEFINITIONS",
          "RUNNER_OFFLINE",
          "REPO_NOT_SET_UP",
        ),
      )
      .input(
        z.object({
          runnerId: z.number().int().positive(),
          path: z.string().startsWith("/", "Use an absolute path"),
          devcontainer: z.string().optional(),
        }),
      )
      .output(repoSchema),
    workflows: oc
      .route({ method: "GET", path: "/repos/{id}/workflows" })
      .errors(
        errors("BAD_REQUEST", "NOT_FOUND", "CONFLICT", "INVALID_DEFINITIONS", "RUNNER_OFFLINE"),
      )
      .input(idInputSchema)
      .output(workflowListSchema),
    workflow: oc
      .route({ method: "GET", path: "/repos/{id}/workflows/{workflow}" })
      .errors(
        errors("BAD_REQUEST", "NOT_FOUND", "CONFLICT", "INVALID_DEFINITIONS", "RUNNER_OFFLINE"),
      )
      .input(idInputSchema.extend({ workflow: z.string().min(1) }))
      .output(workflowSchema),
    // Refused while a run of the repo is active. The checkout and the run branches stay.
    delete: oc
      .route({ method: "DELETE", path: "/repos/{id}" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND", "CONFLICT"))
      .input(idInputSchema)
      .output(deletionSchema),
    // no `hash`: the file must not exist yet
    writeWorkflow: oc
      .route({ method: "PUT", path: "/repos/{id}/workflows/{workflow}" })
      .errors(
        errors("BAD_REQUEST", "NOT_FOUND", "CONFLICT", "INVALID_DEFINITIONS", "RUNNER_OFFLINE"),
      )
      .input(
        idInputSchema.extend({
          workflow: z.string().min(1),
          source: z.string(),
          hash: z.string().optional(),
        }),
      )
      .output(z.object({ path: z.string(), hash: z.string() })),
    // A draft pull request of a `github` repo. The same draft gives the same one.
    publishWorkflow: oc
      .route({ method: "POST", path: "/repos/{id}/workflows/{workflow}/publish" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND", "CONFLICT", "INVALID_WORKFLOW"))
      .input(
        idInputSchema.extend({
          workflow: z.string().min(1),
          source: z.string().max(maxFileMib * mib),
          baseHash: z.string(),
        }),
      )
      .output(z.object({ url: z.string() })),
  },
  runners: {
    list: oc.route({ method: "GET", path: "/runners" }).output(z.array(runnerSchema)),
    update: oc
      .route({ method: "PATCH", path: "/runners/{id}" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND", "CONFLICT"))
      .input(
        idInputSchema.extend({
          labels: runnerSettingsShape.labels.optional(),
          allowedAgents: runnerSettingsShape.allowedAgents.optional(),
          state: z.enum(["active", "draining"]).optional(),
          hasAutoUpdate: z.boolean().optional(),
        }),
      )
      .output(adminRunnerSchema),
    // `isNow`: stop the held runs at once; else the runner restarts when it holds no run.
    requestUpdate: oc
      .route({ method: "POST", path: "/runners/{id}/update" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND", "CONFLICT"))
      .input(idInputSchema.extend({ isNow: z.boolean().default(false) }))
      .output(z.void()),
    cancelUpdate: oc
      .route({ method: "DELETE", path: "/runners/{id}/update" })
      .errors(errors("NOT_FOUND"))
      .input(idInputSchema)
      .output(z.void()),
    // no `path`: the home folder of the runner user
    folders: oc
      .route({ method: "GET", path: "/runners/{id}/folders" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND", "CONFLICT", "RUNNER_OFFLINE"))
      .input(
        idInputSchema.extend({
          path: z.string().startsWith("/", "Use an absolute path").optional(),
        }),
      )
      .output(folderListingSchema),
    revoke: oc
      .route({ method: "POST", path: "/runners/{id}/revoke" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND"))
      .input(idInputSchema)
      .output(adminRunnerSchema),
    // A one-time token, valid for 15 minutes; `runnerId` adds a key to that runner.
    createEnrollmentToken: oc
      .route({ method: "POST", path: "/runners/enrollment-tokens", successStatus: 201 })
      .errors(errors("BAD_REQUEST", "NOT_FOUND", "CONFLICT"))
      .input(
        z.union([
          z.strictObject(runnerSettingsShape),
          z.strictObject({ runnerId: idInputSchema.shape.id }),
        ]),
      )
      .output(z.object({ token: z.string(), expiresAt: z.date() })),
    findRequest: oc
      .route({ method: "GET", path: "/runners/requests/{userCode}" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND"))
      .input(z.object({ userCode: userCodeSchema }))
      .output(runnerRequestSchema),
    approveRequest: oc
      .route({ method: "POST", path: "/runners/requests/{userCode}/approve", successStatus: 201 })
      .errors(errors("BAD_REQUEST", "NOT_FOUND", "CONFLICT"))
      // With `runnerId`, the key of the request replaces the key of that runner at its first connection.
      .input(
        z.union([
          z.strictObject({
            userCode: userCodeSchema,
            name: runnerNameSchema,
            ...runnerSettingsShape,
          }),
          z.strictObject({ userCode: userCodeSchema, runnerId: idInputSchema.shape.id }),
        ]),
      )
      .output(adminRunnerSchema),
  },
  // What `halinka runner` calls before it connects.
  runner: {
    // Each version keeps this route and its fields.
    manifest: oc.route({ method: "GET", path: "/runner/manifest" }).output(
      z.object({
        version: z.string(),
        buildId: z.string(),
        protocolVersion: z.number().int(),
        // the package at `GET /api/runner/package`; absent when the server has none
        package: z.object({ sha512: z.string(), size: z.number().int() }).optional(),
      }),
    ),
    // Each version keeps this route, its input and its results.
    probe: oc
      .route({ method: "POST", path: "/runner/probe" })
      .errors(errors("BAD_REQUEST"))
      .input(signedProbeSchema)
      .output(
        z.discriminatedUnion("result", [
          // `isUpdateRequested`: an Admin or auto-update asked for an update
          z.object({ result: z.literal("accepted"), isUpdateRequested: z.boolean().optional() }),
          // the server has no runner with this key: the runner enrolls
          z.object({ result: z.literal("unknown") }),
          z.object({ result: z.literal("update_needed"), message: z.string() }),
          // the runner tries again: a clock can be right after a time sync
          z.object({ result: z.literal("clock_skew"), message: z.string() }),
          z.object({ result: z.literal("refused"), message: z.string() }),
        ]),
      ),
    reportStatus: oc
      .route({ method: "POST", path: "/runner/status" })
      .errors(errors("BAD_REQUEST"))
      .input(
        signedCallSchema.extend({
          status: z.literal("update_failed"),
          buildId: z.string().max(128),
          reason: z.string().max(4000),
        }),
      )
      .output(
        z.discriminatedUnion("result", [
          z.object({ result: z.literal("accepted") }),
          z.object({ result: z.literal("unknown") }),
          z.object({ result: z.literal("clock_skew"), message: z.string() }),
          z.object({ result: z.literal("refused"), message: z.string() }),
        ]),
      ),
    // The device flow: a repeat gives the same code until an Admin approves it.
    register: oc
      .route({ method: "POST", path: "/runner/registrations" })
      .errors(errors("BAD_REQUEST", "CONFLICT"))
      .input(signedRegistrationSchema)
      .output(
        z.discriminatedUnion("status", [
          z.object({ status: z.literal("approved") }),
          z.object({ status: z.literal("pending"), userCode: z.string(), expiresAt: z.date() }),
        ]),
      ),
    enroll: oc
      .route({ method: "POST", path: "/runner/enroll" })
      .errors(errors("BAD_REQUEST", "CONFLICT"))
      .input(signedRegistrationSchema.extend({ token: z.string().min(1) }))
      .output(z.object({ name: z.string() })),
  },
  costs: {
    list: oc.route({ method: "GET", path: "/costs" }).output(
      z.object({
        days: z.number(),
        totals: z.array(
          z.object({
            repoId: z.number(),
            repoName: z.string(),
            authorId: z.number().optional(),
            authorLogin: z.string().optional(),
            costUsd: z.number(),
            attemptsWithNoCost: z.number(),
          }),
        ),
      }),
    ),
  },
  inbox: {
    list: oc
      .route({ method: "GET", path: "/inbox" })
      .output(z.array(inboxItemSchema({ ...stepShape, ...runLabelSchema.shape }))),
    resolve: oc
      .route({ method: "POST", path: "/inbox/{id}/resolve" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND", "CONFLICT"))
      .input(
        z.union([
          z.strictObject({
            ...idInputSchema.shape,
            decision: z.enum(decisionItemDecisions),
            note: z
              .string()
              .trim()
              .nullish()
              .transform((note) => note || undefined),
          }),
          z.strictObject({ ...idInputSchema.shape, answer: agentAnswerSchema }),
        ]),
      )
      .output(inboxItemSchema({})),
  },
  runs: {
    create: oc
      .route({ method: "POST", path: "/runs", successStatus: 201 })
      .errors(
        errors(
          "BAD_REQUEST",
          "NOT_FOUND",
          "CONFLICT",
          "INVALID_WORKFLOW",
          "INVALID_DEFINITIONS",
          "RUNNER_OFFLINE",
        ),
      )
      .input(
        z.object({
          repoId: z.number().int().positive(),
          workflow: z.string().min(1),
          inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        }),
      )
      .output(runSchema),
    // The test of a draft: it starts from the tip and writes nothing to GitHub.
    test: oc
      .route({ method: "POST", path: "/runs/tests", successStatus: 201 })
      .errors(
        errors(
          "BAD_REQUEST",
          "NOT_FOUND",
          "CONFLICT",
          "INVALID_WORKFLOW",
          "INVALID_DEFINITIONS",
          "RUNNER_OFFLINE",
        ),
      )
      .input(
        z.object({
          repoId: z.number().int().positive(),
          workflow: z.string().min(1),
          source: z.string().max(maxFileMib * mib),
          baseHash: z.string(),
          inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        }),
      )
      .output(runSchema),
    list: oc
      .route({ method: "GET", path: "/runs" })
      .errors(errors("BAD_REQUEST"))
      .input(
        z.object({
          repoId: z.number().int().positive().optional(),
          state: z.enum(["active", "ended"]).optional(),
          beforeId: z.number().int().positive().optional(),
          limit: z.number().int().min(1).max(maxRunPageSize).default(runPageSize),
        }),
      )
      .output(
        z.object({ runs: z.array(runSummarySchema), nextBeforeId: z.number().int().optional() }),
      ),
    totals: oc.route({ method: "GET", path: "/runs/totals" }).output(
      z.object({
        days: z.number(),
        runs: z.number(),
        succeeded: z.number(),
        failed: z.number(),
        // UTC days of the period, oldest first
        perDay: z.array(
          z.object({
            day: z.string(),
            succeeded: z.number(),
            failed: z.number(),
            // cancelled, expired or not ended
            other: z.number(),
          }),
        ),
      }),
    ),
    get: oc
      .route({ method: "GET", path: "/runs/{id}" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND"))
      .input(idInputSchema)
      .output(runDetailSchema),
    events: oc
      .route({ method: "GET", path: "/runs/{id}/events" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND"))
      .input(runEventsInputSchema)
      .output(z.array(storedRunEventSchema)),
    watch: oc
      .route({ method: "GET", path: "/runs/{id}/stream" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND"))
      .input(runEventsInputSchema)
      .output(eventIterator(runChangeSchema)),
    cancel: oc
      .route({ method: "POST", path: "/runs/{id}/cancel" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND"))
      .input(idInputSchema)
      .output(runSchema),
    // Refused for an active run. The run branch stays.
    delete: oc
      .route({ method: "DELETE", path: "/runs/{id}" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND", "CONFLICT"))
      .input(idInputSchema)
      .output(deletionSchema),
    // Starts or stops the container of a finished run. A start counts the workspace TTL again.
    setSandbox: oc
      .route({ method: "PUT", path: "/runs/{id}/sandbox" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND", "CONFLICT"))
      .input(idInputSchema.extend({ spec: z.enum(["running", "stopped"]) }))
      .output(runSchema),
    sshHostKey: oc
      .route({ method: "GET", path: "/runs/{id}/ssh-host-key" })
      .errors(errors("NOT_FOUND", "CONFLICT"))
      .input(idInputSchema)
      .output(z.object({ runnerId: z.number(), sshHostKey: z.string() })),
    push: oc
      .route({ method: "POST", path: "/runs/{id}/push" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND", "CONFLICT", "RUNNER_OFFLINE"))
      .input(idInputSchema)
      .output(z.object({ pushedCommit: z.string() })),
    // Pushes first. The draft pull request targets the default branch of the GitHub repo.
    openPullRequest: oc
      .route({ method: "POST", path: "/runs/{id}/pull-request" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND", "CONFLICT", "RUNNER_OFFLINE"))
      .input(idInputSchema)
      .output(z.object({ pullRequestUrl: z.string() })),
    // The runner removes the sandbox of a finished run; the run branch stays.
    removeSandbox: oc
      .route({ method: "DELETE", path: "/runs/{id}/sandbox" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND", "CONFLICT"))
      .input(idInputSchema)
      .output(runSchema),
    // Interrupts the turn and resolves a pending item; to a finished step run, it reopens the step.
    sendMessage: oc
      .route({ method: "POST", path: "/runs/{id}/steps/{stepRunId}/messages", successStatus: 201 })
      .errors(errors("BAD_REQUEST", "NOT_FOUND", "CONFLICT"))
      .input(
        idInputSchema.extend({
          stepRunId: z.number().int().positive(),
          text: z.string().trim().min(1, "Write a message"),
        }),
      )
      .output(agentMessageSchema),
    // The run goes back to a failed `github` step.
    retryStep: oc
      .route({ method: "POST", path: "/runs/{id}/steps/{stepRunId}/retry" })
      .errors(errors("BAD_REQUEST", "NOT_FOUND", "CONFLICT"))
      .input(idInputSchema.extend({ stepRunId: z.number().int().positive() }))
      .output(z.object({ stepRunId: z.number() })),
  },
};
