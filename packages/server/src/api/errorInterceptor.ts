import { mapEventIterator, ORPCError } from "@orpc/client";
import type { ErrorMap } from "@orpc/contract";
import { validateORPCError } from "@orpc/server";

import { ServiceError } from "../services/serviceError";
import { apiErrors } from "./contract";

type InterceptorOptions<T> = {
  procedure: { "~orpc": { errorMap: ErrorMap } };
  next: () => Promise<T>;
};

const toApiError = async (error: unknown, errorMap: ErrorMap) => {
  if (error instanceof ServiceError) {
    const { code, message, details } = error;
    const status = apiErrors[code].status;
    const apiError = new ORPCError(code, { status, message, data: details, cause: error });
    const validated = await validateORPCError(errorMap, apiError);
    if (!validated.defined) console.error(error);
    return validated;
  }
  if (!(error instanceof ORPCError) || error.code === "INTERNAL_SERVER_ERROR") console.error(error);
  return error;
};

const isAsyncIterator = (value: unknown): value is AsyncIterator<unknown> =>
  typeof value === "object" && value !== null && Symbol.asyncIterator in value;

// oRPC answers every error that is not an ORPCError with INTERNAL_SERVER_ERROR.
export const mapServiceErrors = async <T>(options: InterceptorOptions<T>): Promise<T> => {
  const { errorMap } = options.procedure["~orpc"];
  try {
    const output = await options.next();
    if (!isAsyncIterator(output)) return output;
    const mapped = mapEventIterator(output, {
      value: async (value) => value,
      error: (error) => toApiError(error, errorMap),
    });
    return mapped as T;
  } catch (error) {
    throw await toApiError(error, errorMap);
  }
};
