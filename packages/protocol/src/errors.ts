export type ProtocolErrorCode =
  | "lease_lost"
  | "result_refused"
  | "connection_closed"
  // the server cannot reach its database now; the runner repeats the call
  | "unavailable"
  // an error of the server that a repeat cannot fix
  | "internal"
  // ends the runner connection for good; the runner shows the message
  | "refused"
  // a `refused` for another protocol version; install the build of the server
  | "update_needed"
  // the server shows the message of these to the user
  | "invalid_input"
  | "invalid_definitions"
  | "conflict"
  // the server makes it when the runner does not answer a command in `commandTimeoutMs`
  | "timeout";

// Only `code` and `message` cross the transport, so check an error with `hasCode`, not `instanceof`.
export class ProtocolError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export const leaseLost = (workflowRunId: number) =>
  new ProtocolError("lease_lost", `The lease of run ${workflowRunId} is not held`);

export const connectionClosed = () =>
  new ProtocolError("connection_closed", "The runner connection is closed");

export const refused = (message: string) => new ProtocolError("refused", message);

export const updateNeeded = (message: string) => new ProtocolError("update_needed", message);

export const isRefusal = (error: unknown): error is ProtocolError =>
  hasCode(error, "refused") || hasCode(error, "update_needed");

export const unavailable = (message: string) => new ProtocolError("unavailable", message);

export const internalError = (message: string) => new ProtocolError("internal", message);

export const invalidInput = (message: string) => new ProtocolError("invalid_input", message);

export const invalidDefinitions = (message: string) =>
  new ProtocolError("invalid_definitions", message);

export const conflict = (message: string) => new ProtocolError("conflict", message);

export const codeOf = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

export const hasCode = (error: unknown, code: ProtocolErrorCode) => codeOf(error) === code;

export const isTransient = (error: unknown) =>
  hasCode(error, "connection_closed") || hasCode(error, "unavailable");
