import type { ApiError } from "@halinka/server/client";
import { type UseMutationOptions, useMutation } from "@tanstack/react-query";

export type Submitted<Output> =
  | { data: Output; error?: undefined }
  | { data?: undefined; error: ApiError };

// A form write runs as a mutation, so the mutation cache sees a 401 and ends the session.
export const useSubmitMutation = <Output, Input, TError extends ApiError = ApiError>(
  options: UseMutationOptions<Output, TError, Input>,
) => {
  const { mutateAsync } = useMutation(options);
  return (input: Input): Promise<Submitted<Output>> =>
    mutateAsync(input).then(
      (data) => ({ data }),
      (error: TError) => ({ error }),
    );
};
