import {
  codeOf,
  type ControlPlane,
  controlPlaneMethods,
  internalError,
  ProtocolError,
  unavailable,
  wrapMethods,
} from "@halinka/protocol";
import { errorMessage } from "@halinka/utils/errors";

// SQLSTATE: a lost connection, too many connections, a shutdown, a conflict of two transactions
const repeatableStatePattern = /^(08\w{3}|53300|57P0[123]|40001|40P01)$/;
const networkCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "EAI_AGAIN"]);
// node-postgres gives these without a code.
const lostConnectionMessages = [
  "Connection terminated",
  "timeout exceeded when trying to connect",
  "Client has encountered a connection error and is not queryable",
];

const causesOf = (error: unknown) => {
  const causes: Error[] = [];
  for (let cause = error; cause instanceof Error; cause = cause.cause) causes.push(cause);
  return causes;
};

export const isDatabaseUnavailable = (error: unknown) =>
  causesOf(error).some((cause) => {
    const code = codeOf(cause);
    if (typeof code === "string" && (repeatableStatePattern.test(code) || networkCodes.has(code))) {
      return true;
    }
    return lostConnectionMessages.some((message) => cause.message.includes(message));
  });

// SQLSTATE 55P03: a NOWAIT lock found a row that another transaction holds.
export const isLockNotAvailable = (error: unknown) =>
  causesOf(error).some((cause) => codeOf(cause) === "55P03");

// The runner repeats a call only after `unavailable`, so a bug of the server ends the call.
export const classifiedPlane = (plane: ControlPlane) =>
  wrapMethods(plane, controlPlaneMethods, (method, name) => async (...args) => {
    try {
      return await method(...args);
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      if (isDatabaseUnavailable(error)) {
        throw unavailable(`The database is not available: ${errorMessage(error)}`);
      }
      console.error(error);
      throw internalError(`The server could not complete ${name}`);
    }
  });
