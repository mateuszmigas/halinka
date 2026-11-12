export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const abortError = () => new DOMException("The operation was aborted", "AbortError");

export const isAbortError = (error: unknown) =>
  error instanceof Error && error.name === "AbortError";

export const errnoCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
