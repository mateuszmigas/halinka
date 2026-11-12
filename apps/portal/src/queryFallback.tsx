import { type ApiError, isDefinedError } from "@halinka/server/client";

import { ErrorText } from "./errorText";
import { NotFoundPage } from "./notFoundPage";

export type QueryFallbackProps = { error: ApiError | null };

export const QueryFallback = (props: QueryFallbackProps) => {
  const { error } = props;

  if (isDefinedError(error) && error.code === "NOT_FOUND") return <NotFoundPage />;
  if (error) return <ErrorText error={error} />;
  return <p className="text-muted-foreground">Loading…</p>;
};
