import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { halinkaHome } from "@halinka/utils/halinkaHome";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import * as schema from "./schema";

export type DbLocation =
  | { kind: "postgres"; url: string }
  | { kind: "pglite"; dataFolder?: string };

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export type DbConnection = { db: Db; close: () => Promise<void> };

export const dbLocationFromEnv = (): DbLocation => {
  const url = process.env.DATABASE_URL;
  if (url) return { kind: "postgres", url };
  return { kind: "pglite", dataFolder: join(halinkaHome(), "db") };
};

const options = { schema, casing: "snake_case" } as const;

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

const openPostgres = async (url: string): Promise<DbConnection> => {
  const [{ drizzle }, { migrate }] = await Promise.all([
    import("drizzle-orm/node-postgres"),
    import("drizzle-orm/node-postgres/migrator"),
  ]);
  const db = drizzle({ ...options, connection: url });
  await migrate(db, { migrationsFolder });
  return { db, close: () => db.$client.end() };
};

const openPglite = async (dataFolder?: string): Promise<DbConnection> => {
  const [{ drizzle }, { migrate }] = await Promise.all([
    import("drizzle-orm/pglite"),
    import("drizzle-orm/pglite/migrator"),
  ]);
  if (dataFolder) await mkdir(dataFolder, { recursive: true });
  const db = drizzle({ ...options, connection: { dataDir: dataFolder } });
  await migrate(db, { migrationsFolder });
  return { db, close: () => db.$client.close() };
};

export const openDb = (location: DbLocation) =>
  location.kind === "postgres" ? openPostgres(location.url) : openPglite(location.dataFolder);

export const pingDb = async (db: Db) => {
  await db.execute(sql`select 1`);
};
