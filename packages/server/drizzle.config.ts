import { defineConfig } from "drizzle-kit";

import { dbLocationFromEnv } from "./src/db/client";

const shared = {
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./src/db/migrations",
  casing: "snake_case",
} as const;

const location = dbLocationFromEnv();

export default defineConfig(
  location.kind === "postgres"
    ? { ...shared, dbCredentials: { url: location.url } }
    : { ...shared, driver: "pglite", dbCredentials: { url: location.dataFolder ?? "" } },
);
