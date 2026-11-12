import {
  createORPCClient,
  isDefinedError,
  ORPCError,
  type InferClientErrorUnion,
  type InferClientOutputs,
} from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import type { JsonifiedClient } from "@orpc/openapi-client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";

import { contract } from "./api/contract";

export { isDefinedError, ORPCError, safe } from "@orpc/client";
export { runSshPath } from "./runSshPath";
export type {
  AgentAnswer,
  AgentQuestions,
  AttemptStatus,
  DecisionItemDecision,
  DecisionItemKind,
  InboxItemDecision,
  InboxItemKind,
  RunEvent,
  RunStatus,
  StepRunStatus,
} from "@halinka/protocol";
export {
  answerProblem,
  isRunResult,
  kindDecisions,
  mergeRunEvents,
  textChunkOf,
} from "@halinka/protocol";
export { maxRunPageSize } from "./api/contract";
export { watchRun, type WatchRunOptions } from "./watchRun";

export type ApiClient = JsonifiedClient<ContractRouterClient<typeof contract>>;

export type ApiOutputs = InferClientOutputs<ApiClient>;

export type StoredRunEvent = ApiOutputs["runs"]["events"][number];

export type ApiError = InferClientErrorUnion<ApiClient>;

export type ApiClientOptions = {
  token?: string;
  fetch?: (request: Request, init: RequestInit) => Promise<Response>;
};

export const createApiClient = (url: string, options: ApiClientOptions = {}): ApiClient => {
  const { token, fetch: send = fetch } = options;
  return createORPCClient(
    new OpenAPILink(contract, {
      url: `${url}/api`,
      // The server refuses a write without this header, and oRPC sends none without a body.
      fetch: (request, init) => {
        if (request.method !== "GET") request.headers.set("content-type", "application/json");
        if (token) request.headers.set("authorization", `Bearer ${token}`);
        return send(request, init);
      },
    }),
  );
};

export const isUnauthorized = (error: unknown) =>
  error instanceof ORPCError && error.status === 401;

// `field` is the dotted input path; the problems of an invalid workflow have the field `workflow`.
export type ApiIssue = {
  message: string;
  field?: string;
  location?: { line: number; column: number };
};

export const apiIssues = (error: ApiError): ApiIssue[] => {
  if (!isDefinedError(error)) return [];
  if (error.code === "INVALID_WORKFLOW") {
    return error.data.problems.map(({ message, line, column }) => ({
      message,
      field: "workflow",
      location: { line, column },
    }));
  }
  if (error.code !== "BAD_REQUEST") return [];
  return (error.data?.issues ?? []).map(({ path, message }) => ({
    message,
    ...(path && { field: path.join(".") }),
  }));
};
