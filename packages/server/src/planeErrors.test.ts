import { type ControlPlane, controlPlaneMethods, leaseLost } from "@halinka/protocol";
import { leaseOf } from "@halinka/protocol/testing";
import { describe, expect, it, vi } from "vitest";

import { classifiedPlane } from "./planeErrors";

const failingPlane = (error: unknown) =>
  classifiedPlane(
    Object.fromEntries(
      controlPlaneMethods.map((name) => [
        name,
        async () => {
          throw error;
        },
      ]),
    ) as unknown as ControlPlane,
  );

const lease = leaseOf(1);

const failedQuery = (cause: Error) => new Error("Failed query: select 1", { cause });

describe("classifiedPlane", () => {
  it("keeps the code of a protocol error", async () => {
    await expect(failingPlane(leaseLost(1)).branchCreated(lease)).rejects.toMatchObject({
      code: "lease_lost",
    });
  });

  it.each([
    [
      "a database shutdown",
      failedQuery(Object.assign(new Error("terminating"), { code: "57P01" })),
    ],
    ["a refused connection", Object.assign(new Error("connect"), { code: "ECONNREFUSED" })],
    ["a lost connection", failedQuery(new Error("Connection terminated unexpectedly"))],
    ["a broken connection", failedQuery(Object.assign(new Error("broken"), { code: "08006" }))],
    [
      "a conflict of transactions",
      failedQuery(Object.assign(new Error("retry"), { code: "40001" })),
    ],
    ["a full pool", new Error("timeout exceeded when trying to connect")],
    [
      "a client after a lost connection",
      new Error("Client has encountered a connection error and is not queryable"),
    ],
  ])("gives unavailable for %s", async (_, error) => {
    await expect(failingPlane(error).branchCreated(lease)).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("gives internal for another error and logs it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const bug = new TypeError("x is undefined");

    await expect(failingPlane(bug).branchCreated(lease)).rejects.toMatchObject({
      code: "internal",
      message: "The server could not complete branchCreated",
    });
    expect(log).toHaveBeenCalledWith(bug);
  });

  it("gives internal for a database error that a repeat cannot fix", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const unique = failedQuery(Object.assign(new Error("duplicate key"), { code: "23505" }));

    await expect(failingPlane(unique).branchCreated(lease)).rejects.toMatchObject({
      code: "internal",
    });
    expect(log).toHaveBeenCalledWith(unique);
  });
});
