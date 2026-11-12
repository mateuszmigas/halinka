import type { Usage } from "@halinka/protocol";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createRepositories } from "../db/repositories";
import { stepAttempts, stepRuns } from "../db/schema";
import { createConnectedTestServer, setUpTestDb } from "../testing";

const testDb = setUpTestDb();

const setUp = async () => {
  const server = await createConnectedTestServer(testDb());
  const { plane, startAgentStep } = server;
  const finishedAttempt = async (usage?: Usage, sessionId?: string) => {
    const { claimed, attemptId } = await startAgentStep();
    const status = "succeeded" as const;
    await plane.finishAttempt(claimed.lease, attemptId, {
      result: { status, usage, sessionId },
      stepResult: { status },
    });
    await plane.finishRun(claimed.lease, "succeeded");
  };
  return { ...server, finishedAttempt };
};

describe("GET /api/costs", () => {
  it("adds the costs of the attempts of a repo and an author", async () => {
    const { api, finishedAttempt } = await setUp();
    await finishedAttempt({ activeMs: 1, costUsd: 0.5 }, "s1");
    await finishedAttempt({ activeMs: 1, costUsd: 0.25 }, "s2");

    const { totals } = await api.costs.list();

    expect(totals).toEqual([
      {
        repoId: 1,
        repoName: "app",
        costUsd: 0.75,
        attemptsWithNoCost: 0,
      },
    ]);
  });

  it("gives the runs of a member their own row", async () => {
    const { api, plane, claimOne, services, finishedAttempt } = await setUp();
    await finishedAttempt({ activeMs: 1, costUsd: 1 }, "s1");
    const member = await createRepositories(testDb()).member.create({
      githubId: "7",
      login: "ada",
      role: "member",
    });
    const read = await services.repo.readWorkflow(1, "implement");
    await services.run.createFrom(1, read, { authorId: member!.id });
    const { lease } = await claimOne();
    const stepRunId = await plane.startStep(lease, "implement");
    const { attemptId } = await plane.startAttempt(lease, stepRunId);
    const status = "succeeded" as const;
    const usage = { activeMs: 1, costUsd: 2 };
    await plane.finishAttempt(lease, attemptId, {
      result: { status, usage, sessionId: "s2" },
      stepResult: { status },
    });

    const { totals } = await api.costs.list();

    const byCost = totals.toSorted((first, second) => second.costUsd - first.costUsd);
    expect(byCost.map(({ authorLogin, costUsd }) => [authorLogin, costUsd])).toEqual([
      ["ada", 2],
      [undefined, 1],
    ]);
  });

  it("counts a finished agent attempt with no cost apart", async () => {
    const { api, finishedAttempt } = await setUp();
    await finishedAttempt({ activeMs: 1 }, "s1");

    const { totals } = await api.costs.list();

    expect(totals).toMatchObject([{ costUsd: 0, attemptsWithNoCost: 1 }]);
  });

  it("leaves out an attempt with no session and no cost", async () => {
    const { api, finishedAttempt } = await setUp();
    await finishedAttempt({ activeMs: 1 });

    const { totals } = await api.costs.list();

    expect(totals).toEqual([]);
  });

  it("does not count a running attempt as an attempt with no cost", async () => {
    const { api, startAgentStep } = await setUp();
    const { attemptId } = await startAgentStep();
    await createRepositories(testDb()).stepAttempt.setSession(1, attemptId, { sessionId: "s1" });

    const { totals } = await api.costs.list();

    expect(totals).toEqual([]);
  });

  it("does not count a lost attempt as an attempt with no cost", async () => {
    const { api, startAgentStep } = await setUp();
    const { attemptId } = await startAgentStep();
    const { stepAttempt } = createRepositories(testDb());
    await stepAttempt.setSession(1, attemptId, { sessionId: "s1" });
    await stepAttempt.closeRunning(1, "lost");

    const { totals } = await api.costs.list();

    expect(totals).toEqual([]);
  });

  it("does not count a cancelled attempt as an attempt with no cost", async () => {
    const { api, startAgentStep } = await setUp();
    const { attemptId } = await startAgentStep();
    const { stepAttempt } = createRepositories(testDb());
    await stepAttempt.setSession(1, attemptId, { sessionId: "s1" });
    await stepAttempt.closeRunning(1, "cancelled");

    const { totals } = await api.costs.list();

    expect(totals).toEqual([]);
  });

  it("leaves out an attempt that started more than 30 days ago", async () => {
    const { api, finishedAttempt } = await setUp();
    await finishedAttempt({ activeMs: 1, costUsd: 1 }, "s1");
    await testDb()
      .update(stepAttempts)
      .set({ startedAt: sql`now() - make_interval(days => 31)` });

    const { totals } = await api.costs.list();

    expect(totals).toEqual([]);
  });

  it("counts the cost of a step run that a reopen replaced", async () => {
    const { api, finishedAttempt } = await setUp();
    await finishedAttempt({ activeMs: 1, costUsd: 1 }, "s1");
    await testDb().update(stepRuns).set({ status: "superseded" });

    const { totals } = await api.costs.list();

    expect(totals).toMatchObject([{ costUsd: 1 }]);
  });
});
