import { type QueryKey, useQueryClient } from "@tanstack/react-query";

export const useInvalidateQueries = (...keys: QueryKey[]) => {
  const queryClient = useQueryClient();
  return () => Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
};
