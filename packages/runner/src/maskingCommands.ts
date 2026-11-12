import {
  codeOf,
  ProtocolError,
  type ProtocolErrorCode,
  type RunnerCommands,
  runnerCommandMethods,
  wrapMethods,
} from "@halinka/protocol";

import type { LentValues } from "./lentValues";

// Only `code` and `message` of an error cross the transport.
export const maskedError = (error: unknown, lent: LentValues) => {
  if (!(error instanceof Error)) return lent.mask(error);
  const code = codeOf(error);
  const message = lent.mask(error.message);
  return typeof code === "string"
    ? new ProtocolError(code as ProtocolErrorCode, message)
    : new Error(message);
};

// `async`, so a synchronous throw is masked too.
export const maskingCommands = (commands: RunnerCommands, lent: LentValues) =>
  wrapMethods(commands, runnerCommandMethods, (method) => async (...args) => {
    try {
      return await method(...args);
    } catch (error) {
      throw maskedError(error, lent);
    }
  });
