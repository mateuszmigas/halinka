import { isDefinedError, isUnauthorized } from "@halinka/server/client";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { api } from "./api";
import { router } from "./router";

import "./index.css";

// The layout shows the login page when a session ends during the visit.
const onError = (error: unknown) => {
  if (isUnauthorized(error)) void queryClient.invalidateQueries({ queryKey: api.session.key() });
};

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      retry: (failureCount, error) =>
        !isDefinedError(error) && !isUnauthorized(error) && failureCount < 3,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
