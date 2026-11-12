import { once } from "node:events";
import { type Duplex, duplexPair } from "node:stream";

import { fakeTimers } from "@halinka/utils/testing";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { ApiUser } from "./auth/auth";
import { Relays } from "./relays";
import { RunBus } from "./runBus";
import { ServiceError } from "./services/serviceError";
import {
  createConnectedTestServer,
  devcontainerConfig,
  implementWorkflow,
  setUpTestDb,
} from "./testing";

const workflowRunId = 5;
const publicKey = "key-1";
const instanceId = "process-1";

const octo: ApiUser = { memberId: 1, login: "octo", role: "member", cliLoginId: 1 };

const firstChunk = async (stream: NodeJS.ReadableStream) => String((await once(stream, "data"))[0]);

const setUp = () => {
  const bus = new RunBus();
  const state = {
    user: octo as ApiUser | undefined,
    refusal: undefined as Error | undefined,
    runnerOnline: true,
    loginFails: false,
    leavesDuringLogin: false,
  };
  const session = {
    publicKey,
    instanceId,
    commands: { openRelay: vi.fn(async (_input: { relayId: string }) => {}) },
  };
  let personStream: Duplex | undefined;
  const relayRefusal = vi.fn(async () => state.refusal);
  const relays = new Relays({
    findUser: async () => {
      if (state.leavesDuringLogin) personStream?.destroy();
      if (state.loginFails) throw new Error("The database is not available");
      return state.user;
    },
    runs: {
      openRelay: async () => {
        if (state.refusal) throw state.refusal;
        return 1;
      },
      relayRefusal,
    },
    bus,
    sessionOf: () => (state.runnerOnline ? session : undefined),
  });
  onTestFinished(() => relays.close());

  const openPerson = async (run = workflowRunId) => {
    const [person, serverSide] = duplexPair();
    const closed = Promise.withResolvers<string>();
    personStream = serverSide;
    await relays.open(run, {
      headers: { authorization: "Bearer token" },
      stream: serverSide,
      close: closed.resolve,
    });
    return { person, serverSide, closed: closed.promise };
  };

  const relayIdOfCall = (call: number) => session.commands.openRelay.mock.calls[call]![0].relayId;

  const attachRunner = (call = 0) => {
    const [runner, serverSide] = duplexPair();
    const attach = relays.accept({ relayId: relayIdOfCall(call), publicKey, instanceId });
    attach?.(serverSide);
    return { runner, serverSide };
  };

  return { relays, bus, state, session, openPerson, attachRunner, relayIdOfCall, relayRefusal };
};

const testDb = setUpTestDb();

const withOpenRelay = async () => {
  const context = await createConnectedTestServer(testDb());
  const { files, api, plane, claimOne, commands, services, bus, runnerId } = context;
  files[".halinka/config.yml"] = devcontainerConfig;
  files[".halinka/workflows/implement.yml"] = implementWorkflow;
  await api.runs.create({ repoId: 1, workflow: "implement" });
  const { lease } = await claimOne([], "devcontainer");
  const stepRunId = await plane.startStep(lease, "implement");
  const { attemptId } = await plane.startAttempt(lease, stepRunId);
  const done = { status: "succeeded", summary: "Done" } as const;
  await plane.finishAttempt(lease, attemptId, { result: done, stepResult: done });
  await plane.finishRun(lease, "succeeded");
  await api.runs.setSandbox({ id: 1, spec: "running" });
  await plane.reportSandbox({
    workflowRunId: 1,
    generation: 3,
    observed: "running",
    attach: { containerName: "loving_borg", containerFolder: "/workspaces/run-1" },
  });
  const relays = new Relays({
    findUser: async () => octo,
    runs: services.run,
    bus,
    sessionOf: (id) => (id === runnerId ? { publicKey, instanceId, commands } : undefined),
  });
  onTestFinished(() => relays.close());
  const [, serverSide] = duplexPair();
  const closed = Promise.withResolvers<string>();
  await relays.open(1, { headers: {}, stream: serverSide, close: closed.resolve });
  return { ...context, relays, stepRunId, closed: closed.promise };
};

describe("Relays", () => {
  it("refuses a person without a login", async () => {
    const { state, openPerson, session } = setUp();
    state.user = undefined;

    const { closed } = await openPerson();

    expect(await closed).toBe("Log in first: halinka login");
    expect(session.commands.openRelay).not.toHaveBeenCalled();
  });

  it("gives a person the refusal of the run", async () => {
    const { state, openPerson } = setUp();
    state.refusal = new ServiceError("CONFLICT", "The container of run 5 does not run");

    const { closed } = await openPerson();

    expect(await closed).toBe("The container of run 5 does not run");
  });

  it("refuses a run whose runner is offline", async () => {
    const { state, openPerson } = setUp();
    state.runnerOnline = false;

    const { closed } = await openPerson();

    expect(await closed).toBe("The runner is not connected");
  });

  it("asks the runner for the relay of the run", async () => {
    const { openPerson, session } = setUp();

    await openPerson();

    expect(session.commands.openRelay).toHaveBeenCalledWith({
      relayId: expect.any(String),
      workflowRunId,
    });
  });

  it("carries bytes between the person and the runner", async () => {
    const { openPerson, attachRunner } = setUp();
    const { person } = await openPerson();

    const { runner } = attachRunner();
    const atRunner = firstChunk(runner);
    person.write("from the person");
    const atPerson = firstChunk(person);
    runner.write("from the runner");

    expect(await atRunner).toBe("from the person");
    expect(await atPerson).toBe("from the runner");
  });

  it("refuses a relay socket with another key", async () => {
    const { openPerson, relays, relayIdOfCall } = setUp();
    await openPerson();

    expect(
      relays.accept({ relayId: relayIdOfCall(0), publicKey: "other", instanceId }),
    ).toBeUndefined();
  });

  it("refuses a relay socket of another process", async () => {
    const { openPerson, relays, relayIdOfCall } = setUp();
    await openPerson();

    expect(
      relays.accept({ relayId: relayIdOfCall(0), publicKey, instanceId: "other" }),
    ).toBeUndefined();
  });

  it("refuses a relay socket for an unknown relay", async () => {
    const { relays } = setUp();

    expect(relays.accept({ relayId: "unknown", publicKey, instanceId })).toBeUndefined();
  });

  it("gives a person the refusal of the runner", async () => {
    const { openPerson, session } = setUp();
    session.commands.openRelay.mockRejectedValueOnce(new Error("Run 5 is active on this runner"));

    const { closed } = await openPerson();

    expect(await closed).toBe("Run 5 is active on this runner");
  });

  it("writes who opens a container to the log", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { openPerson } = setUp();

    await openPerson();

    expect(log).toHaveBeenCalledWith("octo opened the container of run 5");
  });

  it("ends the stream of the runner when the person leaves", async () => {
    const { openPerson, attachRunner } = setUp();
    const { serverSide: personSide } = await openPerson();
    const { serverSide } = attachRunner();
    const closed = once(serverSide, "close");

    personSide.destroy();

    await closed;
  });

  it("frees the place of a relay when the person leaves", async () => {
    const { openPerson, session } = setUp();
    const first = await openPerson();
    for (let open = 0; open < 3; open++) await openPerson();
    const leaving = once(first.serverSide, "close");

    first.serverSide.destroy();
    await leaving;
    await openPerson();

    expect(session.commands.openRelay).toHaveBeenCalledTimes(5);
  });

  it("opens nothing for a person who left during the check of the login", async () => {
    const { openPerson, session, state } = setUp();
    state.leavesDuringLogin = true;

    await openPerson();

    expect(session.commands.openRelay).not.toHaveBeenCalled();
  });

  it("closes the relays when the server stops", async () => {
    const { openPerson, relays } = setUp();
    const { closed } = await openPerson();

    relays.close();

    expect(await closed).toBe("The server stops");
  });

  it("refuses a person when the check of the login fails", async () => {
    const { state, openPerson } = setUp();
    state.loginFails = true;

    const { closed } = await openPerson();

    expect(await closed).toBe("Log in first: halinka login");
  });

  it("keeps a relay when the later check of the login fails", async () => {
    fakeTimers(["setInterval", "clearInterval"]);
    const { state, openPerson, attachRunner } = setUp();
    const { person } = await openPerson();
    const { runner } = attachRunner();

    state.loginFails = true;
    await vi.advanceTimersByTimeAsync(30_000);
    const atRunner = firstChunk(runner);
    person.write("still open");

    expect(await atRunner).toBe("still open");
  });

  it("refuses a second socket for one relay", async () => {
    const { openPerson, attachRunner, relays, relayIdOfCall } = setUp();
    await openPerson();
    attachRunner();

    expect(relays.accept({ relayId: relayIdOfCall(0), publicKey, instanceId })).toBeUndefined();
  });

  it("closes both sides when a change of the run refuses the relay", async () => {
    const { openPerson, attachRunner, bus, state } = setUp();
    const { closed } = await openPerson();
    const { serverSide } = attachRunner();

    state.refusal = new ServiceError("CONFLICT", "Run 5 is active");
    bus.notify(workflowRunId, "state");

    expect(await closed).toBe("Run 5 is active");
    expect(serverSide.destroyed).toBe(true);
  });

  it("keeps a relay when a change of the run allows it", async () => {
    const { openPerson, attachRunner, bus, relayRefusal } = setUp();
    const { person } = await openPerson();
    const { runner } = attachRunner();

    bus.notify(workflowRunId, "state");
    await vi.waitFor(() => expect(relayRefusal).toHaveResolved());
    const atRunner = firstChunk(runner);
    person.write("still open");

    expect(await atRunner).toBe("still open");
  });

  it("closes a relay when a claim commits during the open", async () => {
    const { state, session, openPerson, bus } = setUp();
    session.commands.openRelay.mockImplementationOnce(async () => {
      state.refusal = new ServiceError("CONFLICT", "Run 5 is active");
      bus.notify(workflowRunId, "state");
    });

    const { closed } = await openPerson();

    expect(await closed).toBe("Run 5 is active");
  });

  it("closes a relay at the next check when the login ends", async () => {
    fakeTimers(["setInterval", "clearInterval"]);
    const { openPerson, attachRunner, state } = setUp();
    const { closed } = await openPerson();
    attachRunner();

    state.user = undefined;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await closed).toBe("Log in first: halinka login");
  });

  it("closes the relays of a runner process that lost its connection", async () => {
    const { openPerson, attachRunner, relays, session } = setUp();
    const { closed } = await openPerson();
    attachRunner();

    relays.endSession(session);

    expect(await closed).toBe("The runner lost the connection");
  });

  it("closes the relay when the runner ends it", async () => {
    const { openPerson, attachRunner } = setUp();
    const { closed } = await openPerson();

    attachRunner().serverSide.destroy();

    expect(await closed).toBe("The runner ended the session");
  });

  it("limits the open relays of a run", async () => {
    const { openPerson } = setUp();
    for (let open = 0; open < 4; open++) await openPerson();

    const { closed } = await openPerson();

    expect(await closed).toBe(`Run ${workflowRunId} has too many open sessions`);
  });

  it("limits the open relays of a person", async () => {
    const { openPerson } = setUp();
    for (let run = 0; run < 8; run++) await openPerson(run);

    const { closed } = await openPerson(8);

    expect(await closed).toBe("You have too many open sessions");
  });

  it("opens a relay to the container of a finished run", async () => {
    const { commands } = await withOpenRelay();

    expect(commands.openRelay).toHaveBeenCalledWith({
      relayId: expect.any(String),
      workflowRunId: 1,
    });
  });

  it("closes the relay when a person reopens the run", async () => {
    const { api, stepRunId, closed } = await withOpenRelay();

    await api.runs.sendMessage({ id: 1, stepRunId, text: "Use SQLite" });

    expect(await closed).toBe("Run 1 is active. Cancel it first.");
  });
});
