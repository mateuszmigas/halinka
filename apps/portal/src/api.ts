import { createApiClient } from "@halinka/server/client";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

export const api = createTanstackQueryUtils(createApiClient(window.location.origin));
