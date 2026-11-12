import { useQuery } from "@tanstack/react-query";

import { api } from "../api";

export const useIsAdmin = () => {
  const { data: session } = useQuery(api.session.queryOptions());
  return session?.user?.role === "admin";
};
