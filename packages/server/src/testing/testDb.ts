import { is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach } from "vitest";

import { type Db, type DbConnection, openDb } from "../db/client";
import { createRepositories } from "../db/repositories";
import * as schema from "../db/schema";

const tables = Object.values(schema).filter((value) => is(value, PgTable));

export const cleanTestDb = async (db: Db) => {
  await db.execute(sql`truncate ${sql.join(tables, sql`, `)} restart identity`);
};

export const setUpTestDb = () => {
  let connection: DbConnection | undefined;
  const testDb = () => {
    if (!connection) throw new Error("The test database is not open");
    return connection.db;
  };
  beforeAll(async () => {
    connection = await openDb({ kind: "pglite" });
  });
  beforeEach(() => cleanTestDb(testDb()));
  afterAll(() => connection?.close());
  return testDb;
};

export const registerTestRunner = async (db: Db, name: string) => {
  const { runner, runnerKey } = createRepositories(db);
  const created = await runner.create({ name });
  if (!created) throw new Error(`The test runner ${name} was not registered`);
  await runnerKey.create(created.id, testKeyOf(name), "current");
  return created;
};

export const testKeyOf = (name: string) => `${name}-key`;
