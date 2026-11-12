import type { EngineResult } from "@halinka/engine";
import {
  type ClaimedAgentTest,
  connectionClosed,
  invalidInput,
  leaseLost,
  type RunnerCapabilities,
  ProtocolError,
  type RunLease,
  type RunResult,
  type SandboxTarget,
  type SyncRequest,
  type SyncResult,
} from "@halinka/protocol";
import { leaseOf, testBuild, testSyncRequest } from "@halinka/protocol/testing";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { LentValues } from "./lentValues";
import { type ExecuteClaimedRun, Supervisor } from "./supervisor";
import { claimedRun, fakePlane } from "./testing";

const { capabilities } = testSyncRequest;

const answerOf = (workflowRunId: number, itemId: number, decision: "approve" | "reject") => ({
  workflowRunId,
  itemId,
  decision,
  resolvedBy: "local",
});

const withDocker: RunnerCapabilities = {
  sandboxKind: "devcontainer",
  build: testBuild,
  canUpdate: false,
  hasDocker: true,
  hasSysbox: false,
  sshHostKey: "ssh-ed25519 AAAA",
};

const withoutDocker: RunnerCapabilities = { ...withDocker, hasDocker: false };

const nothing = { keep: [], claimed: [], answers: [], messages: [], sandboxes: [] };

// Each `sync` takes the next response; without one, the server keeps every held run.
const createFakePlane = (refuse: (lease: RunLease, result: RunResult) => Error | undefined) => {
  const syncs: SyncRequest[] = [];
  const responses: (SyncResult | Error)[] = [];
  const results: string[] = [];
  const errors: (string | null | undefined)[] = [];
  const plane = fakePlane({
    sync: async (request) => {
      syncs.push(request);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return (
        response ?? { ...nothing, keep: request.held.map(({ workflowRunId }) => workflowRunId) }
      );
    },
    finishRun: async (lease, result, runError) => {
      results.push(`${lease.workflowRunId} ${result}`);
      errors.push(runError);
      const error = refuse(lease, result);
      if (error) throw error;
    },
  });
  return { plane, syncs, responses, results, errors };
};

// Each engine runs until the test ends it or the supervisor aborts it.
const createFakeEngines = () => {
  const engines = new Map<number, PromiseWithResolvers<EngineResult>>();
  const signals = new Map<number, AbortSignal>();
  const execute: ExecuteClaimedRun = (run, _inbox, signal) => {
    const engine = Promise.withResolvers<EngineResult>();
    signal.addEventListener("abort", () => engine.resolve("aborted"));
    engines.set(run.lease.workflowRunId, engine);
    signals.set(run.lease.workflowRunId, signal);
    return engine.promise;
  };
  const engine = (workflowRunId: number) => {
    const found = engines.get(workflowRunId);
    if (!found) throw new Error(`Run ${workflowRunId} has no engine`);
    return found;
  };
  return { execute, engine, signals };
};

type SetUpOptions = {
  firstSync?: SyncResult | Error;
  lent?: LentValues;
  startCapabilities?: RunnerCapabilities;
  inspectCapabilities?: () => Promise<RunnerCapabilities>;
  onClaim?: (workflowRunId: number) => void;
  onUpdate?: () => void;
  isFree?: boolean;
  isSweepDue?: boolean;
  refuse?: (lease: RunLease, result: RunResult) => Error | undefined;
};

const setUp = (
  execute?: ExecuteClaimedRun,
  {
    firstSync,
    lent = new LentValues(),
    startCapabilities = capabilities,
    inspectCapabilities = async () => startCapabilities,
    onClaim = () => {},
    onUpdate = () => {},
    isFree = true,
    isSweepDue = false,
    refuse = () => undefined,
  }: SetUpOptions = {},
) => {
  const fake = createFakePlane(refuse);
  if (firstSync) fake.responses.push(firstSync);
  const fakeEngines = createFakeEngines();
  const appliedSandboxes: SandboxTarget[][] = [];
  const appliedKinds: ("apply" | "sweep")[] = [];
  const startedTests: ClaimedAgentTest[] = [];
  const supervisor = new Supervisor({
    plane: fake.plane,
    capacity: 1,
    capabilities: startCapabilities,
    inspectCapabilities,
    pollMs: 60_000,
    execute: execute ?? fakeEngines.execute,
    lent,
    sandboxes: {
      isSweepDue: () => isSweepDue,
      apply: (targets) => {
        appliedSandboxes.push(targets);
        appliedKinds.push("apply");
      },
      sweep: (targets) => {
        appliedSandboxes.push(targets);
        appliedKinds.push("sweep");
      },
    },
    agentTests: { isFree: () => isFree, start: (test) => startedTests.push(test) },
    onClaim,
    onUpdate,
  });
  supervisor.start();
  onTestFinished(() => supervisor.stop());
  const claim = async (workflowRunId: number) => {
    fake.responses.push({ ...nothing, claimed: [claimedRun(workflowRunId)] });
    supervisor.wake();
    await vi.waitFor(() => expect(supervisor.held()).toEqual([leaseOf(workflowRunId)]));
  };
  const syncTimes = async (count: number) => {
    for (let index = fake.syncs.length; index < count; index++) {
      supervisor.wake();
      await vi.waitFor(() => expect(fake.syncs.length).toBeGreaterThan(index));
    }
  };
  return {
    ...fake,
    syncTimes,
    ...fakeEngines,
    supervisor,
    claim,
    appliedSandboxes,
    appliedKinds,
    startedTests,
  };
};

describe("Supervisor", () => {
  it("asks for the restart of an update when it holds no run", async () => {
    const onUpdate = vi.fn();

    setUp(undefined, { firstSync: { ...nothing, update: "when_idle" }, onUpdate });

    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
  });

  it("waits for its agent test before the restart of an update", async () => {
    const onUpdate = vi.fn();
    const { syncTimes, syncs } = setUp(undefined, {
      firstSync: { ...nothing, update: "when_idle" },
      isFree: false,
      onUpdate,
    });

    await syncTimes(syncs.length + 1);

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("waits for its runs before the restart of an update", async () => {
    const onUpdate = vi.fn();
    const { claim, responses, syncTimes, syncs } = setUp(undefined, { onUpdate });
    await claim(1);
    responses.push({ ...nothing, keep: [1], update: "when_idle" });

    await syncTimes(syncs.length + 1);

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("asks for the restart of an update at once when the server wants it now", async () => {
    const onUpdate = vi.fn();
    const { claim, responses, supervisor } = setUp(undefined, { onUpdate });
    await claim(1);
    responses.push({ ...nothing, keep: [1], update: "now" });

    supervisor.wake();

    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
  });

  it("starts the agent test of a sync", async () => {
    const test = { token: "token-1", preset: "codex" };
    const { startedTests } = setUp(undefined, { firstSync: { ...nothing, agentTest: test } });

    await vi.waitFor(() => expect(startedTests).toEqual([test]));
  });

  it.each([true, false])(
    "tells the server that a process with free %s can test",
    async (isFree) => {
      const { syncs } = setUp(undefined, { isFree });

      await vi.waitFor(() => expect(syncs[0]?.canTest).toBe(isFree));
    },
  );

  it("tells of a claim before the engine of the run starts", async () => {
    const order: string[] = [];
    const { claim } = setUp(
      (_run, _inbox, signal) => {
        order.push("engine");
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve("aborted")));
      },
      { onClaim: (workflowRunId) => order.push(`claim ${workflowRunId}`) },
    );

    await claim(1);

    expect(order).toEqual(["claim 1", "engine"]);
  });

  it("holds a claimed run", async () => {
    const { claim, supervisor } = setUp();

    await claim(1);

    expect(supervisor.isHolding(1)).toBe(true);
  });

  it("does not hold a run after its end", async () => {
    const { claim, engine, supervisor } = setUp();
    await claim(1);

    engine(1).resolve("succeeded");

    await vi.waitFor(() => expect(supervisor.isHolding(1)).toBe(false));
  });

  it("lists a claimed run as held in the next sync", async () => {
    const { claim, supervisor, syncs } = setUp();
    await claim(1);

    supervisor.wake();

    await vi.waitFor(() => expect(syncs.at(-1)).toMatchObject({ held: [leaseOf(1)], capacity: 0 }));
  });

  it("syncs the free slot of a run that waits for a person at once", async () => {
    const { claim, syncs } = setUp(async (_run, inbox, signal) => {
      await inbox.waitForDecision(5, signal);
      return "succeeded";
    });

    await claim(1);

    await vi.waitFor(() => expect(syncs.at(-1)).toMatchObject({ held: [leaseOf(1)], capacity: 1 }));
  });

  it("takes the slot again when the decision arrives", async () => {
    const { claim, syncs, responses, supervisor } = setUp(async (_run, inbox, signal) => {
      await inbox.waitForDecision(5, signal);
      return new Promise<EngineResult>((resolve) =>
        signal.addEventListener("abort", () => resolve("aborted")),
      );
    });
    await claim(1);
    responses.push({ ...nothing, keep: [1], answers: [answerOf(1, 5, "approve")] });

    supervisor.wake();
    await vi.waitFor(() => expect(responses).toEqual([]));
    supervisor.wake();

    await vi.waitFor(() => expect(syncs.at(-1)).toMatchObject({ held: [leaseOf(1)], capacity: 0 }));
  });

  it("asks for every sandbox when a sweep is due", async () => {
    const { syncs } = setUp(undefined, { isSweepDue: true });

    await vi.waitFor(() => expect(syncs[0]).toMatchObject({ isSweep: true }));
  });

  it("does not ask for every sandbox when no sweep is due", async () => {
    const { syncs } = setUp();

    await vi.waitFor(() => expect(syncs[0]).toMatchObject({ isSweep: false }));
  });

  it("sweeps the list of every sandbox", async () => {
    const { appliedKinds } = setUp(undefined, { isSweepDue: true });

    await vi.waitFor(() => expect(appliedKinds).toEqual(["sweep"]));
  });

  it("applies the list of a sync without a sweep", async () => {
    const { appliedKinds } = setUp();

    await vi.waitFor(() => expect(appliedKinds).toEqual(["apply"]));
  });

  it("applies no list after a failed sync", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { syncs, appliedKinds } = setUp(undefined, {
      firstSync: new Error("Connection lost"),
      isSweepDue: true,
    });

    await vi.waitFor(() => expect(syncs).toHaveLength(1));

    expect(appliedKinds).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      "The runner could not sync with the server",
      expect.any(Error),
    );
  });

  it("applies the sandboxes of the runs without an engine in this process", async () => {
    const { claim, responses, supervisor, appliedSandboxes } = setUp();
    await claim(1);
    const sandboxOf = (workflowRunId: number): SandboxTarget => ({
      workflowRunId,
      kind: "worktree",
      repoPath: "/code/app",
      baseSha: "abc",
      definitionSha: "abc",
      spec: "stopped",
      generation: 2,
    });

    responses.push({ ...nothing, keep: [1], sandboxes: [sandboxOf(1), sandboxOf(2)] });
    supervisor.wake();

    await vi.waitFor(() => expect(appliedSandboxes.at(-1)).toEqual([sandboxOf(2)]));
  });

  it("stores the engine's result, then stops holding the run", async () => {
    const { claim, engine, supervisor, results } = setUp();
    await claim(1);

    engine(1).resolve("succeeded");

    await vi.waitFor(() => expect(supervisor.held()).toEqual([]));
    expect(results).toEqual(["1 succeeded"]);
  });

  it("syncs again at once when an engine ends", async () => {
    const { claim, engine, syncs } = setUp();
    await claim(1);
    const before = syncs.length;

    engine(1).resolve("succeeded");

    await vi.waitFor(() => expect(syncs.length).toBeGreaterThan(before));
  });

  it("gives each decision from sync to the engine of its run", async () => {
    const decisions: string[] = [];
    const { claim, responses, supervisor, results } = setUp(async (run, inbox, signal) => {
      decisions.push(
        `${run.lease.workflowRunId} ${(await inbox.waitForDecision(7, signal)).decision}`,
      );
      return "succeeded";
    });
    await claim(1);

    responses.push({ ...nothing, keep: [1], answers: [answerOf(1, 7, "approve")] });
    supervisor.wake();

    await vi.waitFor(() => expect(results).toEqual(["1 succeeded"]));
    expect(decisions).toEqual(["1 approve"]);
  });

  it("gives each message from sync to the engine of its run", async () => {
    const taken: string[] = [];
    const { claim, responses, supervisor, results } = setUp(async (run, inbox, signal) => {
      await inbox.messageArrived(3, signal);
      taken.push(...inbox.takeMessages(3).map(({ text }) => `${run.lease.workflowRunId} ${text}`));
      return "succeeded";
    });
    await claim(1);

    const messages = [
      { workflowRunId: 1, messageId: 5, stepRunId: 3, text: "Use SQLite", author: "local" },
    ];
    responses.push({ ...nothing, keep: [1], messages });
    supervisor.wake();

    await vi.waitFor(() => expect(results).toEqual(["1 succeeded"]));
    expect(taken).toEqual(["1 Use SQLite"]);
  });

  it("gives the decisions to the runs it claims in the same sync", async () => {
    const decisions: string[] = [];
    const { responses, supervisor, results } = setUp(async (run, inbox, signal) => {
      const { decision } = await inbox.waitForDecision(run.lease.workflowRunId, signal);
      decisions.push(`${run.lease.workflowRunId} ${decision}`);
      return "succeeded";
    });

    responses.push({
      ...nothing,
      claimed: [claimedRun(1), claimedRun(2)],
      answers: [answerOf(2, 2, "reject"), answerOf(1, 1, "approve")],
    });
    supervisor.wake();

    await vi.waitFor(() => expect(results).toHaveLength(2));
    expect(decisions.sort()).toEqual(["1 approve", "2 reject"]);
  });

  it("syncs again after a sync fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { responses, supervisor, claim } = setUp();
    responses.push(new Error("The runner connection is closed"));
    supervisor.wake();
    await vi.waitFor(() => expect(error).toHaveBeenCalled());

    await claim(1);
  });

  it("aborts the engine of a run that leaves keep", async () => {
    const { claim, signals, supervisor, responses } = setUp();
    await claim(1);

    responses.push(nothing);
    supervisor.wake();

    await vi.waitFor(() => expect(signals.get(1)?.aborted).toBe(true));
  });

  it("stores cancelled for a run that leaves keep", async () => {
    const { claim, supervisor, responses, results } = setUp();
    await claim(1);

    responses.push(nothing);
    supervisor.wake();

    await vi.waitFor(() => expect(results).toEqual(["1 cancelled"]));
  });

  it("stores cancelled when a cancel makes the start of the run throw", async () => {
    const { responses, supervisor, results } = setUp(async (_run, _inbox, signal) => {
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
      throw signal.reason;
    });
    responses.push({ ...nothing, claimed: [claimedRun(1)] });
    supervisor.wake();
    await vi.waitFor(() => expect(responses).toEqual([]));

    responses.push(nothing);
    supervisor.wake();

    await vi.waitFor(() => expect(results).toEqual(["1 cancelled"]));
  });

  it("masks a lent value in the log of an engine that throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const lent = new LentValues();
    lent.add("NPM_TOKEN", "sk-lent-value");
    const execute = async (): Promise<never> => {
      throw new Error("npm failed with sk-lent-value");
    };
    const { responses, supervisor, results } = setUp(execute, { lent });

    responses.push({ ...nothing, claimed: [claimedRun(1)] });
    supervisor.wake();
    await vi.waitFor(() => expect(results).toEqual(["1 failed"]));

    expect(error.mock.calls.flat().join(" ")).not.toContain("sk-lent-value");
  });

  it("stores failed when the engine throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { responses, supervisor, results } = setUp(async () => {
      throw new Error("The workspace is gone");
    });

    responses.push({ ...nothing, claimed: [claimedRun(1)] });
    supervisor.wake();

    await vi.waitFor(() => expect(results).toEqual(["1 failed"]));
    expect(error).toHaveBeenCalledWith("Run 1 stopped: The workspace is gone");
  });

  it("sends the error of an engine that throws with the result", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { responses, supervisor, errors } = setUp(async () => {
      throw new Error("The workspace is gone");
    });

    responses.push({ ...nothing, claimed: [claimedRun(1)] });
    supervisor.wake();

    await vi.waitFor(() => expect(errors).toEqual(["The workspace is gone"]));
    expect(error).toHaveBeenCalledWith("Run 1 stopped: The workspace is gone");
  });

  it("cuts the error of the result to the length the server keeps", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { responses, supervisor, errors } = setUp(async () => {
      throw new Error("x".repeat(9000));
    });

    responses.push({ ...nothing, claimed: [claimedRun(1)] });
    supervisor.wake();

    await vi.waitFor(() => expect(errors[0]).toHaveLength(8000));
    expect(error).toHaveBeenCalledWith(`Run 1 stopped: ${"x".repeat(9000)}`);
  });

  it("masks a lent value in the error before it cuts the error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const lent = new LentValues();
    lent.add("API_KEY", "sk-secret-value");
    const { responses, supervisor, errors } = setUp(
      async () => {
        throw new Error(`${"x".repeat(7995)}sk-secret-value`);
      },
      { lent },
    );

    responses.push({ ...nothing, claimed: [claimedRun(1)] });
    supervisor.wake();

    await vi.waitFor(() => expect(errors).toEqual([`${"x".repeat(7995)}***`]));
    expect(error).toHaveBeenCalledWith(`Run 1 stopped: ${"x".repeat(7995)}***`);
  });

  it("sends the capabilities of the start until the 12th sync", async () => {
    const later: RunnerCapabilities = {
      sandboxKind: "worktree",
      build: testBuild,
      canUpdate: false,
      agentsOnPath: ["codex"],
    };
    const { syncs, syncTimes } = setUp(undefined, { inspectCapabilities: async () => later });

    await syncTimes(13);

    expect(syncs.slice(0, 12).map((sync) => sync.capabilities)).toEqual(
      Array(12).fill(capabilities),
    );
    expect(syncs[12]?.capabilities).toEqual(later);
  });

  it("warns at the start when Docker is not available", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { syncs } = setUp(undefined, { startCapabilities: withoutDocker });

    await vi.waitFor(() => expect(syncs).toHaveLength(1));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Docker is not available"));
  });

  it("warns once while Docker stays unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { syncTimes } = setUp(undefined, { startCapabilities: withoutDocker });

    await syncTimes(13);

    expect(warn).toHaveBeenCalledOnce();
  });

  it("warns when Docker stops", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { syncTimes } = setUp(undefined, {
      startCapabilities: withDocker,
      inspectCapabilities: async () => withoutDocker,
    });

    await syncTimes(13);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Docker is not available"));
  });

  it("tells when Docker is available again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { syncTimes } = setUp(undefined, {
      startCapabilities: withoutDocker,
      inspectCapabilities: async () => withDocker,
    });

    await syncTimes(13);

    expect(warn).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Docker is available"));
  });

  it("sends failed once when the server refuses the result", async () => {
    const { claim, engine, results } = setUp(undefined, {
      refuse: (_, result) =>
        result === "succeeded" ? new ProtocolError("result_refused", "A step runs") : undefined,
    });
    await claim(1);

    engine(1).resolve("succeeded");

    await vi.waitFor(() => expect(results).toEqual(["1 succeeded", "1 failed"]));
  });

  it("sends failed with the refusal when the server refuses the result as invalid", async () => {
    const { claim, engine, results, errors } = setUp(undefined, {
      refuse: (_, result) =>
        result === "succeeded" ? invalidInput("The result is bad") : undefined,
    });
    await claim(1);

    engine(1).resolve("succeeded");

    await vi.waitFor(() => expect(results).toEqual(["1 succeeded", "1 failed"]));
    expect(errors).toEqual([undefined, "The result is bad"]);
  });

  it("keeps holding the run while the server refuses failed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { claim, engine, results, supervisor, syncs } = setUp(undefined, {
      refuse: () => invalidInput("The result is bad"),
    });
    await claim(1);
    engine(1).resolve("succeeded");
    await vi.waitFor(() => expect(results).toEqual(["1 succeeded", "1 failed"]));
    const synced = syncs.length;

    supervisor.wake();

    await vi.waitFor(() => expect(syncs.length).toBeGreaterThan(synced));
    expect(syncs.at(-1)?.held).toEqual([leaseOf(1)]);
    expect(error).toHaveBeenCalledWith("Run 1: the server refused the result", expect.any(Error));
  });

  it("does not start a second engine for a run it already executes", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let engines = 0;
    const { responses, supervisor } = setUp((_run, _inbox, signal) => {
      engines++;
      return new Promise<EngineResult>((resolve) =>
        signal.addEventListener("abort", () => resolve("aborted")),
      );
    });
    responses.push({ ...nothing, claimed: [claimedRun(1), claimedRun(1)] });

    supervisor.wake();

    await vi.waitFor(() => expect(supervisor.held()).toEqual([leaseOf(1)]));
    expect(engines).toBe(1);
    expect(error).toHaveBeenCalledWith("Run 1 already has an engine in this process");
  });

  it("drops the run without a retry when its lease is lost", async () => {
    const { claim, engine, results, supervisor } = setUp(undefined, {
      refuse: ({ workflowRunId }) => leaseLost(workflowRunId),
    });
    await claim(1);

    engine(1).resolve("failed");

    await vi.waitFor(() => expect(supervisor.held()).toEqual([]));
    expect(results).toEqual(["1 failed"]);
  });

  it("aborts the engines at a stop", async () => {
    const { claim, signals, supervisor } = setUp();
    await claim(1);

    await supervisor.stop();

    expect(signals.get(1)?.aborted).toBe(true);
  });

  it("sends no result of an aborted engine at a stop", async () => {
    const { claim, supervisor, results } = setUp();
    await claim(1);

    await supervisor.stop();

    expect(results).toEqual([]);
  });

  it("gives the runs back at a stop", async () => {
    const { claim, supervisor, syncs } = setUp();
    await claim(1);

    await supervisor.stop();

    expect(syncs.at(-1)).toEqual({ held: [], capacity: 0, capabilities });
  });

  it("sends no last sync on a stop that does not give the runs back", async () => {
    const { claim, supervisor, syncs } = setUp();
    await claim(1);
    const count = syncs.length;

    await supervisor.stop({ isGivingBack: false });

    expect(syncs).toHaveLength(count);
  });

  it("sends no result when the engine throws during a stop", async () => {
    const { supervisor, responses, results } = setUp(
      (_run, _inbox, signal) =>
        new Promise<EngineResult>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("The step was stopped"))),
        ),
    );
    responses.push({ ...nothing, claimed: [claimedRun(1)] });
    supervisor.wake();
    await vi.waitFor(() => expect(supervisor.held()).toEqual([leaseOf(1)]));

    await supervisor.stop();

    expect(results).toEqual([]);
  });

  it("does not send a result again during a stop", async () => {
    const { supervisor, responses, results } = setUp(
      (_run, _inbox, signal) =>
        new Promise<EngineResult>((resolve) =>
          signal.addEventListener("abort", () => resolve("succeeded")),
        ),
      { refuse: () => connectionClosed() },
    );
    responses.push({ ...nothing, claimed: [claimedRun(1)] });
    supervisor.wake();
    await vi.waitFor(() => expect(supervisor.held()).toEqual([leaseOf(1)]));

    await supervisor.stop();

    expect(results).toEqual(["1 succeeded"]);
  });

  it("sends no result when the engine loses its lease", async () => {
    let executed = false;
    const { supervisor, responses, results } = setUp(async ({ lease }) => {
      executed = true;
      throw leaseLost(lease.workflowRunId);
    });

    responses.push({ ...nothing, claimed: [claimedRun(1)] });
    supervisor.wake();

    await vi.waitFor(() => expect(executed).toBe(true));
    await vi.waitFor(() => expect(supervisor.held()).toEqual([]));
    expect(results).toEqual([]);
  });
});
