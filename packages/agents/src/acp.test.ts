import { access } from "node:fs/promises";
import { join } from "node:path";

import type { Sandbox, SpawnOptions } from "@halinka/sandbox";
import { HostSandbox, stopLeftoverGroups } from "@halinka/sandbox/host";
import { tempFolder, fakeTimers } from "@halinka/utils/testing";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { AcpAgent, type AgentLaunch, agentTestQuestion } from "./acp";
import type { AgentContext, AgentEvent, AgentSession, CreateReportChannel } from "./agent";
import { FileReportChannel } from "./fileReportChannel/fileReportChannel";
import { type FakeAction, fakeAcpAgentCommand, fakeAgentPrompt } from "./testing";

const oneTurn = (...actions: FakeAction[]) => fakeAgentPrompt([actions]);

const startWith =
  (launch: AgentLaunch = {}, command = fakeAcpAgentCommand) =>
  async () => ({ command, launch });

const agentWith = (
  launch?: AgentLaunch,
  toolsMeta?: (tools: string[]) => Record<string, unknown>,
) => new AcpAgent(startWith(launch), FileReportChannel.create, toolsMeta);

const texts = (events: AgentEvent[]) =>
  events.flatMap((event) =>
    event.sessionUpdate === "agent_message_chunk" && event.content.type === "text"
      ? [event.content.text]
      : [],
  );

const createStubChannel = (read = async () => ({})) => {
  let closed = 0;
  const create: CreateReportChannel = async () => ({
    mcpServer: { name: "halinka", command: "true", args: [], env: [] },
    read,
    close: async () => {
      closed++;
    },
  });
  return { create, closed: () => closed };
};

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const docsServer = { name: "docs", command: "docs-server", args: ["--stdio"] };

type ContextOptions = { write?: boolean; sessionId?: string };

type PromptCallOptions = { signal?: AbortSignal; interrupt?: AbortSignal };

const setUp = async () => {
  const folder = await tempFolder();
  const groupsFile = `${folder}.groups`;
  const events: AgentEvent[] = [];
  const sessions: AgentSession[] = [];
  const turns: Promise<unknown>[] = [];
  onTestFinished(async () => {
    await Promise.all(sessions.map((session) => session.close()));
    // A turn that the close ends still reads the report files.
    await Promise.allSettled(turns);
    expect(await stopLeftoverGroups(groupsFile)).toEqual([]);
  });

  const context = ({ write = true, sessionId }: ContextOptions = {}) => ({
    sandbox: new HostSandbox(folder, groupsFile),
    reportShape: {},
    permissions: { write, shell: true, network: true as const },
    sessionId,
  });

  const spawnRecordingSandbox = (onSpawned = () => {}) => {
    const host = new HostSandbox(folder, groupsFile);
    const spawns: SpawnOptions[] = [];
    const sandbox: Sandbox = {
      workspaceFolder: folder,
      exec: (command, options) => host.exec(command, options),
      spawn: async (command, options) => {
        spawns.push(options);
        const spawned = await host.spawn(command, options);
        onSpawned();
        return spawned;
      },
      assignWorkspace: async () => {},
    };
    return { sandbox, spawns };
  };

  const open = async (options: ContextOptions = {}, signal = new AbortController().signal) => {
    const session = await agentWith().open(context(options), signal);
    sessions.push(session);
    return session;
  };

  const prompt = (
    session: AgentSession,
    text: string,
    { signal = new AbortController().signal, interrupt }: PromptCallOptions = {},
  ) => {
    const turn = session.prompt(text, {
      signal,
      interrupt,
      onEvent: (event) => events.push(event),
    });
    turns.push(turn);
    return turn;
  };

  const say = (session: AgentSession, action: FakeAction) => prompt(session, oneTurn(action));
  const lastText = () => texts(events).at(-1);
  const sessionFields = () =>
    JSON.parse(lastText()!) as { servers: { name: string }[]; meta?: unknown };

  const openWith = async (fields: Partial<AgentContext>, launch?: AgentLaunch) => {
    const session = await agentWith(launch, (tools) => ({ listed: tools })).open(
      { ...context(), ...fields },
      new AbortController().signal,
    );
    sessions.push(session);
    return session;
  };

  const reopenWith = async (fields: Partial<AgentContext>) => {
    const first = await openWith(fields);
    await first.close();
    sessions.length = 0;
    const session = await openWith({ ...fields, sessionId: first.sessionId });
    expect(session.isLoaded).toBe(true);
    return session;
  };

  return {
    folder,
    events,
    sessions,
    context,
    spawnRecordingSandbox,
    open,
    prompt,
    say,
    lastText,
    sessionFields,
    openWith,
    reopenWith,
  };
};

describe("AcpAgent", () => {
  it("selects the model", async () => {
    const { say, lastText, openWith } = await setUp();
    await say(await openWith({ model: "fake-large" }), { model: true });

    expect(lastText()).toBe("fake-large");
  });

  it("keeps the model of the agent without a selection", async () => {
    const { say, lastText, openWith } = await setUp();
    await say(await openWith({}), { model: true });

    expect(lastText()).toBe("fake-small");
  });

  it("selects the model again in a loaded session", async () => {
    const { say, lastText, reopenWith } = await setUp();
    await say(await reopenWith({ model: "fake-large" }), { model: true });

    expect(lastText()).toBe("fake-large");
  });

  it("names the models that the agent offers when it refuses a model", async () => {
    const { openWith } = await setUp();
    await expect(openWith({ model: "no-such-model" })).rejects.toThrow(
      /^The agent refused the model no-such-model: .*Invalid params.*\. It offers: fake-small, fake-large$/,
    );
  });

  it("names the models of a group when the agent refuses a model", async () => {
    const { openWith } = await setUp();
    const launch = { env: { HALINKA_FAKE_AGENT_MODELS: "grouped" } };

    await expect(openWith({ model: "no-such-model" }, launch)).rejects.toThrow(
      "It offers: fake-small, fake-large",
    );
  });

  it("refuses a model for an agent that offers no models", async () => {
    const { openWith } = await setUp();
    const launch = { env: { HALINKA_FAKE_AGENT_MODELS: "none" } };

    await expect(openWith({ model: "fake-large" }, launch)).rejects.toThrow(
      "The agent offers no models, so it cannot use fake-large",
    );
  });

  it("gives the exit of the agent during the selection of a model", async () => {
    const { openWith } = await setUp();
    const launch = { env: { HALINKA_FAKE_AGENT_MODELS: "exit" } };

    await expect(openWith({ model: "fake-large" }, launch)).rejects.toThrow(
      "The agent exited with code 3",
    );
  });

  it("gives the servers of the step after the report server", async () => {
    const { say, sessionFields, openWith } = await setUp();
    await say(await openWith({ mcp_servers: [docsServer] }), { session: true });

    expect(sessionFields().servers.slice(1)).toEqual([{ ...docsServer, env: [] }]);
    expect(sessionFields().servers[0]?.name).toBe("halinka");
  });

  it("gives the servers of the step to a loaded session", async () => {
    const { say, sessionFields, reopenWith } = await setUp();
    await say(await reopenWith({ mcp_servers: [docsServer] }), { session: true });

    expect(sessionFields().servers.map(({ name }) => name)).toEqual(["halinka", "docs"]);
  });

  it("gives no arguments to a server without args", async () => {
    const { say, sessionFields, openWith } = await setUp();
    const mcp_servers = [{ name: "docs", command: "docs-server" }];
    await say(await openWith({ mcp_servers }), { session: true });

    expect(sessionFields().servers[1]).toMatchObject({ args: [] });
  });

  it("gives the tools to a new session", async () => {
    const { say, sessionFields, openWith } = await setUp();
    await say(await openWith({ tools: ["Read"] }), { session: true });

    expect(sessionFields().meta).toEqual({ listed: ["Read"] });
  });

  it("gives the tools to a loaded session", async () => {
    const { say, sessionFields, reopenWith } = await setUp();
    await say(await reopenWith({ tools: ["Read"] }), { session: true });

    expect(sessionFields().meta).toEqual({ listed: ["Read"] });
  });

  it("gives no session metadata to a step without tools", async () => {
    const { say, sessionFields, openWith } = await setUp();
    await say(await openWith({}), { session: true });

    expect(sessionFields()).not.toHaveProperty("meta");
  });
  it("starts the session in the workspace folder", async () => {
    const { folder, events, open, prompt } = await setUp();
    const session = await open();

    await prompt(session, oneTurn({ cwd: true }));

    expect(texts(events)).toEqual([folder]);
  });

  it("gets a reply of the fake agent to the question of the agent test", async () => {
    const { events, sessions, context } = await setUp();
    const session = await agentWith().open(context(), new AbortController().signal);
    sessions.push(session);

    await session.prompt(agentTestQuestion, {
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });

    expect(texts(events)).toEqual(["OK"]);
  });

  it("gives the capabilities of the agent", async () => {
    const { sessions, context } = await setUp();
    const session = await agentWith().open(context(), new AbortController().signal);
    sessions.push(session);

    expect(session.capabilities).toEqual({ loadSession: true });
  });

  it("starts the agent with its environment", async () => {
    const { events, sessions, context, prompt } = await setUp();
    const agent = agentWith({
      env: { ANTHROPIC_API_KEY: "key-1" },
    });
    const session = await agent.open(context(), new AbortController().signal);
    sessions.push(session);

    await prompt(session, oneTurn({ env: "ANTHROPIC_API_KEY" }));

    expect(texts(events)).toEqual(["key-1"]);
  });

  it("lets the agent reach its provider hosts and the hosts of the step", async () => {
    const { context, sessions, spawnRecordingSandbox } = await setUp();
    const { sandbox, spawns } = spawnRecordingSandbox();
    const agent = agentWith({
      providerHosts: ["api.anthropic.com"],
    });
    const permissions = { write: true, shell: true, network: ["registry.npmjs.org"] };

    sessions.push(
      await agent.open({ ...context(), sandbox, permissions }, new AbortController().signal),
    );

    expect(spawns.map(({ network }) => network)).toEqual([
      ["api.anthropic.com", "registry.npmjs.org"],
    ]);
  });

  it("lends the agent its credentials", async () => {
    const { context, sessions, spawnRecordingSandbox } = await setUp();
    const { sandbox, spawns } = spawnRecordingSandbox();
    const agent = agentWith({
      credentialNames: ["ANTHROPIC_API_KEY"],
    });

    sessions.push(await agent.open({ ...context(), sandbox }, new AbortController().signal));

    expect(spawns.map(({ credentialNames }) => credentialNames)).toEqual([["ANTHROPIC_API_KEY"]]);
  });

  it("reads the launch of the agent at each open", async () => {
    const { context, sessions, spawnRecordingSandbox } = await setUp();
    const { sandbox, spawns } = spawnRecordingSandbox();
    let credentialNames = ["ANTHROPIC_API_KEY"];
    const agent = new AcpAgent(
      async () => ({ command: fakeAcpAgentCommand, launch: { credentialNames } }),
      FileReportChannel.create,
    );
    sessions.push(await agent.open({ ...context(), sandbox }, new AbortController().signal));
    credentialNames = ["CODEX_LOGIN"];

    sessions.push(await agent.open({ ...context(), sandbox }, new AbortController().signal));

    expect(spawns.map((options) => options.credentialNames)).toEqual([
      ["ANTHROPIC_API_KEY"],
      ["CODEX_LOGIN"],
    ]);
  });

  it("starts the agent as its own user", async () => {
    const { context, sessions, spawnRecordingSandbox } = await setUp();
    const { sandbox, spawns } = spawnRecordingSandbox();
    const agent = agentWith();

    sessions.push(await agent.open({ ...context(), sandbox }, new AbortController().signal));

    expect(spawns.map(({ user }) => user)).toEqual(["agent"]);
  });

  it("lets the agent of a step with network true reach every host", async () => {
    const { context, sessions, spawnRecordingSandbox } = await setUp();
    const { sandbox, spawns } = spawnRecordingSandbox();
    const agent = agentWith({
      providerHosts: ["api.anthropic.com"],
    });
    const permissions = { write: true, shell: true, network: true as const };

    sessions.push(
      await agent.open({ ...context(), sandbox, permissions }, new AbortController().signal),
    );

    expect(spawns.map(({ network }) => network)).toEqual([true]);
  });

  it("starts a new session without a session to load", async () => {
    const { open } = await setUp();
    const session = await open();

    expect(session).toMatchObject({
      sessionId: expect.stringMatching(/^fake-session-/),
      isLoaded: false,
    });
  });

  it("loads the session that the context names", async () => {
    const { open } = await setUp();
    const session = await open({ sessionId: "session-7" });

    expect(session).toMatchObject({ sessionId: "session-7", isLoaded: true });
  });

  it("drops the updates that replay a loaded session", async () => {
    const { events, open, prompt } = await setUp();
    const session = await open({ sessionId: "session-7" });

    await prompt(session, oneTurn({ say: "next" }));

    expect(texts(events)).toEqual(["next"]);
  });

  it("gives the report channel to a loaded session", async () => {
    const { open, prompt } = await setUp();
    const session = await open({ sessionId: "session-7" });

    expect(await prompt(session, oneTurn({ report: { summary: "Done" } }))).toMatchObject({
      report: { summary: "Done" },
    });
  });

  it("starts a new session when the agent refuses the load", async () => {
    const { open } = await setUp();
    const session = await open({ sessionId: "gone-session" });

    expect(session).toMatchObject({
      sessionId: expect.stringMatching(/^fake-session-/),
      isLoaded: false,
    });
  });

  it("drops the updates that the agent sends after the turn", async () => {
    const { folder, events, open, prompt } = await setUp();
    const session = await open();

    await prompt(session, fakeAgentPrompt([[{ afterTurn: "after the turn" }], [{ say: "next" }]]));
    await vi.waitFor(() => access(join(folder, "after-turn-sent")));
    await prompt(session, "Continue");

    expect(texts(events)).toEqual(["next"]);
  });

  it("gives the report that the agent sends with report_result", async () => {
    const { open, prompt } = await setUp();
    const session = await open();

    const turn = await prompt(session, oneTurn({ report: { summary: "Done" } }));

    expect(turn.report).toEqual({ summary: "Done" });
  });

  it("gives no report when the agent reported in an earlier turn only", async () => {
    const { open, prompt } = await setUp();
    const session = await open();
    await prompt(session, fakeAgentPrompt([[{ report: { summary: "Done" } }], []]));

    const turn = await prompt(session, "Continue");

    expect(turn.report).toBeUndefined();
  });

  it("gives the questions that the agent sends with ask_human", async () => {
    const { open, prompt } = await setUp();
    const session = await open();
    const questions = [{ question: "Which database?", header: "Database", multiSelect: false }];

    const turn = await prompt(session, oneTurn({ question: { questions } }));

    expect(turn).toEqual({ stopReason: "end_turn", questions });
  });

  it("gives no report after a failed turn in which the agent reported", async () => {
    const { open, prompt } = await setUp();
    const session = await open();
    await expect(
      prompt(session, fakeAgentPrompt([[{ report: { summary: "Done" } }, { fail: "Failed" }], []])),
    ).rejects.toThrow("Failed");

    const turn = await prompt(session, "Continue");

    expect(turn.report).toBeUndefined();
  });

  it("gives no questions when the agent asked in an earlier turn only", async () => {
    const { open, prompt } = await setUp();
    const session = await open();
    const questions = [{ question: "Which database?", header: "Database" }];
    await prompt(session, fakeAgentPrompt([[{ question: { questions } }], []]));

    const turn = await prompt(session, "Continue");

    expect(turn.questions).toBeUndefined();
  });

  it("gives the stop reason of the turn", async () => {
    const { open, prompt } = await setUp();
    const session = await open();

    const turn = await prompt(session, oneTurn({ stop: "refusal" }));

    expect(turn.stopReason).toBe("refusal");
  });

  it("allows a permission request", async () => {
    const { events, open, prompt } = await setUp();
    const session = await open();

    await prompt(session, oneTurn({ permission: ["reject_once", "allow_once"] }));

    expect(texts(events)).toEqual(["allow_once-id"]);
  });

  it("prefers allow once to allow always", async () => {
    const { events, open, prompt } = await setUp();
    const session = await open();

    await prompt(session, oneTurn({ permission: ["allow_always", "allow_once"] }));

    expect(texts(events)).toEqual(["allow_once-id"]);
  });

  it("allows a permission request for always when the agent does not offer once", async () => {
    const { events, open, prompt } = await setUp();
    const session = await open();

    await prompt(session, oneTurn({ permission: ["reject_once", "allow_always"] }));

    expect(texts(events)).toEqual(["allow_always-id"]);
  });

  it("cancels a permission request that has no allow option", async () => {
    const { events, open, prompt } = await setUp();
    const session = await open();

    await prompt(session, oneTurn({ permission: ["reject_once"] }));

    expect(texts(events)).toEqual(["cancelled"]);
  });

  it.each(["edit", "delete", "move"] as const)(
    "rejects a %s request in a read-only step",
    async (toolKind) => {
      const { events, open, prompt } = await setUp();
      const session = await open({ write: false });

      await prompt(session, oneTurn({ permission: ["allow_once", "reject_once"], toolKind }));

      expect(texts(events)).toEqual(["reject_once-id"]);
    },
  );

  it("rejects an edit for always when the agent does not offer once", async () => {
    const { events, open, prompt } = await setUp();
    const session = await open({ write: false });

    await prompt(
      session,
      oneTurn({ permission: ["allow_once", "reject_always"], toolKind: "delete" }),
    );

    expect(texts(events)).toEqual(["reject_always-id"]);
  });

  it("allows an edit in a step that may write", async () => {
    const { events, open, prompt } = await setUp();
    const session = await open();

    await prompt(session, oneTurn({ permission: ["allow_once", "reject_once"], toolKind: "edit" }));

    expect(texts(events)).toEqual(["allow_once-id"]);
  });

  it("rejects a git command that changes the history", async () => {
    const { events, open, prompt } = await setUp();
    const session = await open();

    await prompt(
      session,
      oneTurn({
        permission: ["allow_once", "reject_once"],
        toolKind: "execute",
        rawInput: { command: "git commit -m fix" },
      }),
    );

    expect(texts(events)).toEqual(["reject_once-id"]);
  });

  it("allows a read in a read-only step", async () => {
    const { events, open, prompt } = await setUp();
    const session = await open({ write: false });

    await prompt(session, oneTurn({ permission: ["allow_once", "reject_once"], toolKind: "read" }));

    expect(texts(events)).toEqual(["allow_once-id"]);
  });

  it("rejects a prompt at once when the signal is already aborted", async () => {
    const { open, prompt } = await setUp();
    const session = await open();

    await expect(prompt(session, "Hello", { signal: AbortSignal.abort() })).rejects.toThrow(
      expect.objectContaining({ name: "AbortError" }),
    );
  });

  it("rejects with the error of the agent when a request fails", async () => {
    const { open, prompt } = await setUp();
    const session = await open();

    await expect(prompt(session, oneTurn({ fail: "The fake agent failed" }))).rejects.toThrow(
      "Internal error: The fake agent failed",
    );
  });

  it("ends the turn when the agent obeys the cancel of the signal", async () => {
    const { events, open, prompt } = await setUp();
    const session = await open();
    const controller = new AbortController();

    const turn = prompt(session, oneTurn({ say: "Waiting" }, { wait: true }), {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(texts(events)).toEqual(["Waiting"]));
    controller.abort();

    await expect(turn).resolves.toEqual({ stopReason: "cancelled" });
  });

  it("stops the agent when it ignores the cancel", async () => {
    const { events, open, prompt } = await setUp();
    const session = await open();
    const controller = new AbortController();

    const turn = prompt(session, oneTurn({ say: "Waiting" }, { hang: true }), {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(texts(events)).toEqual(["Waiting"]));
    controller.abort();

    await expect(turn).rejects.toThrow("The agent exited with code 1");
  }, 10_000);

  it("ends the turn when the agent obeys the cancel of the interrupt", async () => {
    const { events, open, prompt } = await setUp();
    const session = await open();
    const interrupt = new AbortController();

    const turn = prompt(session, oneTurn({ say: "Waiting" }, { wait: true }), {
      interrupt: interrupt.signal,
    });
    await vi.waitFor(() => expect(texts(events)).toEqual(["Waiting"]));
    interrupt.abort();

    await expect(turn).resolves.toEqual({ stopReason: "cancelled" });
  });

  const promptAfterInterrupt = async () => {
    const { events, open, prompt } = await setUp();
    const session = await open();
    const turn = await prompt(session, oneTurn({ say: "Waiting" }, { wait: true }), {
      interrupt: AbortSignal.abort(),
    });
    return { turn, events };
  };

  it("sends the prompt when the interrupt aborted before it", async () => {
    const { events } = await promptAfterInterrupt();

    expect(texts(events)).toEqual(["Waiting"]);
  });

  it("cancels the turn when the interrupt aborted before it", async () => {
    const { turn } = await promptAfterInterrupt();

    expect(turn).toEqual({ stopReason: "cancelled" });
  });

  it("keeps the agent running when it ignores the cancel of an interrupt", async () => {
    const { events, sessions, context, spawnRecordingSandbox, prompt } = await setUp();
    const { sandbox, spawns } = spawnRecordingSandbox();
    const session = await agentWith().open({ ...context(), sandbox }, new AbortController().signal);
    sessions.push(session);
    const interrupt = new AbortController();
    const turn = prompt(session, oneTurn({ say: "Waiting" }, { hang: true }), {
      interrupt: interrupt.signal,
    });
    turn.catch(() => {});
    await vi.waitFor(() => expect(texts(events)).toEqual(["Waiting"]));
    fakeTimers(["setTimeout", "clearTimeout"]);

    interrupt.abort();
    vi.advanceTimersByTime(60_000);

    expect(spawns[0]?.signal?.aborted).toBe(false);
  });

  it("rejects with the exit code and stderr when the agent exits during a turn", async () => {
    const { open, prompt } = await setUp();
    const session = await open();

    await expect(
      prompt(session, oneTurn({ exit: { code: 3, stderr: "The fake agent crashed\n" } })),
    ).rejects.toThrow("The agent exited with code 3: The fake agent crashed");
  });

  it("stops the agent when it closes stdout", async () => {
    const { open, prompt } = await setUp();
    const session = await open();

    await expect(prompt(session, oneTurn({ closeStdout: true }))).rejects.toThrow(
      "The agent exited with code 1",
    );
  });

  it("stops the agent when the signal of open aborts", async () => {
    const { context, spawnRecordingSandbox } = await setUp();
    const controller = new AbortController();
    const { sandbox } = spawnRecordingSandbox(() => controller.abort());
    const agent = agentWith();

    const opened = agent.open({ ...context(), sandbox }, controller.signal);

    await expect(opened).rejects.toThrow("The agent exited with code 1");
  });

  it("starts no agent when the signal aborts while it reads the launch", async () => {
    const { context, spawnRecordingSandbox } = await setUp();
    const controller = new AbortController();
    const { sandbox, spawns } = spawnRecordingSandbox();
    const agent = new AcpAgent(async () => {
      controller.abort();
      return { command: fakeAcpAgentCommand, launch: {} };
    }, FileReportChannel.create);

    await expect(agent.open({ ...context(), sandbox }, controller.signal)).rejects.toThrow(
      "aborted",
    );
    expect(spawns).toEqual([]);
  });

  it("rejects open at once when the signal is already aborted", async () => {
    const { open } = await setUp();
    await expect(open({}, AbortSignal.abort())).rejects.toThrow(
      expect.objectContaining({ name: "AbortError" }),
    );
  });

  it("keeps the agent running when the signal of open aborts after open", async () => {
    const { events, open, prompt } = await setUp();
    const controller = new AbortController();
    const session = await open({}, controller.signal);

    controller.abort();
    await prompt(session, oneTurn({ say: "Hello" }));

    expect(texts(events)).toEqual(["Hello"]);
  });

  it("closes the report channel on close", async () => {
    const { context } = await setUp();
    const channel = createStubChannel();
    const session = await new AcpAgent(startWith(), channel.create).open(
      context(),
      new AbortController().signal,
    );

    await session.close();

    expect(channel.closed()).toBe(1);
  });

  it("ends the session when the read after a failed turn fails", async () => {
    const { sessions, context, prompt } = await setUp();
    const channel = createStubChannel(async () => {
      throw new Error("The read timed out");
    });
    const session = await new AcpAgent(startWith(), channel.create).open(
      context(),
      new AbortController().signal,
    );
    sessions.push(session);

    await expect(prompt(session, oneTurn({ fail: "Failed" }))).rejects.toThrow("Failed");

    expect(channel.closed()).toBe(1);
  });

  it("closes the report channel when open fails", async () => {
    const { context } = await setUp();
    const channel = createStubChannel();

    const opened = new AcpAgent(
      startWith({}, [process.execPath, "-e", "process.exit(2)"]),
      channel.create,
    ).open(context(), new AbortController().signal);

    await expect(opened).rejects.toThrow("The agent exited with code 2");
    expect(channel.closed()).toBe(1);
  });

  it("stops the agent on close", async () => {
    const { events, open, prompt } = await setUp();
    const session = await open();
    await prompt(session, oneTurn({ pid: true }));
    const pid = Number(texts(events)[0]);

    await session.close();

    expect(isRunning(pid)).toBe(false);
  });
});
