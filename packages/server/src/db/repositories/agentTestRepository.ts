import { type AgentTestResult, maxRunErrorLength } from "@halinka/protocol";
import { and, asc, eq, getTableColumns, inArray, ne, or, sql } from "drizzle-orm";

import type { Db } from "../client";
import { agentTests, runners } from "../schema";
import { ownedBy } from "./ownedBy";

const isOpen = inArray(agentTests.status, ["requested", "running"]);

type RequestTestOptions = { runnerId: number; memberId: number | null; token: string };

export class AgentTestRepository {
  constructor(private readonly db: Db) {}

  async request(preset: string, { runnerId, memberId, token }: RequestTestOptions) {
    const values = {
      token,
      status: "requested",
      capabilities: null,
      error: null,
      testedWith: null,
    } as const;
    await this.db
      .insert(agentTests)
      .values({ preset, runnerId, memberId, ...values })
      .onConflictDoUpdate({
        target: [agentTests.runnerId, agentTests.preset, agentTests.memberId],
        set: values,
      });
  }

  // Call it in a transaction. A test of the team comes first: an Admin uses it to find why runs fail.
  lockOpen(runnerId: number) {
    return this.db
      .select()
      .from(agentTests)
      .where(and(eq(agentTests.runnerId, runnerId), isOpen))
      .orderBy(sql`${agentTests.memberId} is not null`, asc(agentTests.updatedAt))
      .for("update", { skipLocked: true });
  }

  async start(id: number, testedWith: string | null) {
    await this.db
      .update(agentTests)
      .set({ status: "running", testedWith })
      .where(eq(agentTests.id, id));
  }

  async fail(id: number, error: string) {
    await this.db.update(agentTests).set({ status: "failed", error }).where(eq(agentTests.id, id));
  }

  async failRunning(runnerId: number, error: string) {
    await this.db
      .update(agentTests)
      .set({ status: "failed", error })
      .where(and(eq(agentTests.runnerId, runnerId), eq(agentTests.status, "running")));
  }

  // An open test of a runner that has not synced, or a running test past the cap.
  async failLost(leaseSeconds: number, capSeconds: number, error: string) {
    const gone = this.db
      .select({ id: runners.id })
      .from(runners)
      .where(sql`${runners.lastSeenAt} < now() - make_interval(secs => ${leaseSeconds})`);
    const pastCap = and(
      eq(agentTests.status, "running"),
      sql`${agentTests.updatedAt} < now() - make_interval(secs => ${capSeconds})`,
    );
    await this.db
      .update(agentTests)
      .set({ status: "failed", error })
      .where(or(and(isOpen, inArray(agentTests.runnerId, gone)), pastCap));
  }

  async finish(token: string, runnerId: number, result: AgentTestResult) {
    const set =
      "error" in result
        ? { status: "failed" as const, error: result.error.slice(0, maxRunErrorLength) }
        : { status: "passed" as const, capabilities: result.capabilities };
    await this.db.update(agentTests).set(set).where(this.runningOf(token, runnerId));
  }

  // Call it in a transaction.
  async holdRunning(token: string, runnerId: number) {
    const [test] = await this.db
      .select({ preset: agentTests.preset, memberId: agentTests.memberId })
      .from(agentTests)
      .where(this.runningOf(token, runnerId))
      .for("share");
    return test;
  }

  list(memberId: number | null) {
    return this.db
      .select({ ...getTableColumns(agentTests), runner: runners.name })
      .from(agentTests)
      .innerJoin(runners, eq(runners.id, agentTests.runnerId))
      .where(and(ne(runners.state, "revoked"), ownedBy(agentTests.memberId, memberId)))
      .orderBy(asc(runners.name));
  }

  private runningOf(token: string, runnerId: number) {
    return and(
      eq(agentTests.token, token),
      eq(agentTests.runnerId, runnerId),
      eq(agentTests.status, "running"),
    );
  }
}
