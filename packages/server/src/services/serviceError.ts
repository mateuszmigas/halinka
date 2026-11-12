export type ServiceErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_WORKFLOW"
  | "INVALID_DEFINITIONS"
  | "RUNNER_OFFLINE"
  | "REPO_NOT_SET_UP";

export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

// `recordReason`: the reason for the record of a delivery, with no text of the event.
type RunRefusalOptions = { recordReason: string; details?: unknown };

export class RunRefusal extends ServiceError {
  readonly recordReason: string;

  constructor(
    code: ServiceErrorCode,
    message: string,
    { recordReason, details }: RunRefusalOptions,
  ) {
    super(code, message, details);
    this.recordReason = recordReason;
  }
}

export const noRun = (id: number) => new ServiceError("NOT_FOUND", `There is no run ${id}`);

export const noStepRun = (workflowRunId: number, stepRunId: number) =>
  new ServiceError("NOT_FOUND", `Run ${workflowRunId} has no step run ${stepRunId}`);

export const noRepo = (id: number) => new ServiceError("NOT_FOUND", `There is no repo ${id}`);

export const noRunner = (idOrName: number | string) =>
  new ServiceError("NOT_FOUND", `There is no runner ${idOrName}`);

export const noOpenRequest = (userCode: string) =>
  new ServiceError("NOT_FOUND", `There is no open request with the code ${userCode}`);

export const noLogin = () => new ServiceError("BAD_REQUEST", "This server has no login");

export const noGitHubAnswer = () =>
  new ServiceError("BAD_REQUEST", "GitHub did not answer. Try again.");

export const invalidWorkflow = (path: string, problems: unknown[]) =>
  new ServiceError("INVALID_WORKFLOW", `${path} is not a valid workflow`, { path, problems });

export const loggedFailureText = (error: unknown) => {
  if (!(error instanceof ServiceError)) console.error(error);
  return failureText(error);
};

export const failureText = (error: unknown) => {
  if (error instanceof RunRefusal) return error.recordReason;
  if (error instanceof ServiceError) return error.message;
  return "The work failed. See the server log.";
};
