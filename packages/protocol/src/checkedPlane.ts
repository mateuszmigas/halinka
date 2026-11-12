import { z } from "zod";

import { agentQuestionsSchema } from "./agentQuestions";
import {
  agentTestResultSchema,
  attemptItemKinds,
  attemptResultSchema,
  type ControlPlane,
  pushedBranchWriteSchema,
  runCallSchema,
  runLeaseSchema,
  runResults,
  sandboxReportSchema,
  stepParentSchema,
  stepRunResultSchema,
  syncRequestSchema,
} from "./controlPlane";
import { invalidInput } from "./errors";
import { wrapMethods } from "./methods";
import { runEventSchema } from "./runEvents";

const idSchema = z.number().int();

// The JSON transport sends a missing argument as null.
const optionalArgument = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((value) => value ?? undefined);

// One schema per method: a missing or an unknown method fails the type check.
const controlPlaneInputSchemas = {
  sync: z.tuple([syncRequestSchema]),
  startStep: z.tuple([runCallSchema, z.string(), optionalArgument(stepParentSchema)]),
  finishStep: z.tuple([runCallSchema, idSchema, stepRunResultSchema]),
  startAttempt: z.tuple([runCallSchema, idSchema]),
  finishAttempt: z.tuple([
    runCallSchema,
    idSchema,
    z.object({ result: attemptResultSchema, stepResult: stepRunResultSchema.optional() }),
  ]),
  appendEvents: z.tuple([
    runLeaseSchema,
    z.object({ batchId: z.string(), events: z.array(runEventSchema) }),
  ]),
  openApproval: z.tuple([runCallSchema, idSchema, z.string()]),
  askHuman: z.tuple([
    runCallSchema,
    idSchema,
    z.object({ result: attemptResultSchema, kind: z.enum(attemptItemKinds), message: z.string() }),
  ]),
  askQuestion: z.tuple([runCallSchema, idSchema, agentQuestionsSchema]),
  branchCreated: z.tuple([runCallSchema]),
  finishRun: z.tuple([runCallSchema, z.enum(runResults), optionalArgument(z.string())]),
  readAgentCredentials: z.tuple([runLeaseSchema, z.string()]),
  readSetupSecrets: z.tuple([runLeaseSchema]),
  readMirrorAccess: z.tuple([runLeaseSchema]),
  readPushAccess: z.tuple([runLeaseSchema, idSchema]),
  storePushedBranch: z.tuple([runCallSchema, idSchema, pushedBranchWriteSchema]),
  readCommentAccess: z.tuple([runLeaseSchema, idSchema]),
  storeComment: z.tuple([runCallSchema, idSchema, z.url({ protocol: /^https$/ })]),
  readTestCredentials: z.tuple([z.string()]),
  finishAgentTest: z.tuple([z.string(), agentTestResultSchema]),
  reportSandbox: z.tuple([sandboxReportSchema]),
} satisfies { [K in keyof ControlPlane]: z.ZodType<Parameters<ControlPlane[K]>> };

export const controlPlaneMethods = Object.keys(controlPlaneInputSchemas) as (keyof ControlPlane)[];

// A runner is not trusted: the plane gets only the checked arguments.
export const checkedPlane = (plane: ControlPlane) =>
  wrapMethods(plane, controlPlaneMethods, (method, name) => async (...args) => {
    const parsed = controlPlaneInputSchemas[name].safeParse(args);
    if (!parsed.success) {
      throw invalidInput(`The input of ${name} is not valid: ${z.prettifyError(parsed.error)}`);
    }
    return method(...parsed.data);
  });
