import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it } from "vitest";

import { openDb } from "./client";
import { runners } from "./schema";

const runner = { name: "local" };

describe("openDb", () => {
  it("applies the migrations to an in-memory PGlite", async () => {
    const { db, close } = await openDb({ kind: "pglite" });
    await db.insert(runners).values(runner);
    expect(await db.select({ id: runners.id, name: runners.name }).from(runners)).toEqual([
      { ...runner, id: 1 },
    ]);
    await close();
  });

  it("keeps PGlite data in its folder", async () => {
    const dataFolder = await tempFolder();

    const first = await openDb({ kind: "pglite", dataFolder });
    await first.db.insert(runners).values(runner);
    await first.close();

    const second = await openDb({ kind: "pglite", dataFolder });
    expect(await second.db.select({ name: runners.name }).from(runners)).toEqual([runner]);
    await second.close();
  });
});
