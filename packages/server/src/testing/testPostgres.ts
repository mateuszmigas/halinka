import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { afterAll, beforeAll, vi } from "vitest";

import { type DbConnection, openDb } from "../db/client";
import { inTransaction, type Repositories } from "../db/repositories/createRepositories";

const run = promisify(execFile);

// PGlite has one connection, so an interleaving of two transactions needs a real server.
export const setUpTestPostgres = () => {
  const container = `halinka-test-${randomUUID()}`;
  let connection: DbConnection;

  beforeAll(async () => {
    await run("docker", [
      "run",
      "--rm",
      "-d",
      "--name",
      container,
      "-e",
      "POSTGRES_PASSWORD=test",
      "-p",
      "127.0.0.1::5432",
      "postgres:17",
    ]);
    const { stdout } = await run("docker", ["port", container, "5432/tcp"]);
    const url = `postgres://postgres:test@${stdout.trim().split("\n")[0]}/postgres`;
    await vi.waitFor(
      async () => {
        await run("docker", ["exec", container, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"]);
      },
      { timeout: 60_000, interval: 500 },
    );
    connection = await openDb({ kind: "postgres", url });
  }, 180_000);

  afterAll(async () => {
    // A failed test can leave a transaction open, and the close then waits for it.
    await Promise.race([connection?.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
    await run("docker", ["rm", "-f", container]);
  });

  // Holds a transaction open until `release` is called.
  const openTransaction = async <T>(use: (repositories: Repositories) => Promise<T>) => {
    const released = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<T>();
    const done = inTransaction(connection.db, async (repositories) => {
      reached.resolve(await use(repositories));
      await released.promise;
    });
    return { result: await reached.promise, release: released.resolve, done };
  };

  return { connection: () => connection, openTransaction };
};
