import { type ApiError, apiIssues, isUnauthorized } from "@halinka/server/client";
import { errorMessage } from "@halinka/utils/errors";

import { logInHint } from "./logins";

export const problemLine = ({ line, message }: { line: number; message: string }) =>
  `line ${line}: ${message}`;

export const formatApiFailure = (error: ApiError, server: string) => {
  if (isUnauthorized(error)) return logInHint(server);
  const details = apiIssues(error).map(({ message, field, location }) => {
    if (location) return problemLine({ line: location.line, message });
    return field === undefined ? message : `${field}: ${message}`;
  });
  return [errorMessage(error), ...details].join("\n  ");
};
