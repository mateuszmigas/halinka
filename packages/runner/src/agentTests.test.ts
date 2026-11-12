import type { AcpAgent } from "@halinka/agents/acp";
import type { ClaimedAgentTest } from "@halinka/protocol";
import { maxRunErrorLength, refused } from "@halinka/protocol";
import type { Sandbox } from "@halinka/sandbox";
import { describe, expect, it, vi } from "vitest";

import { AgentTests, askAgent } from "./agentTests";
import { LentValues } from "./lentValues";

const test: ClaimedAgentTest = { token: "token-1", preset: "codex" };

const sandbox = { assignWorkspace: async () => {} } as Partial<Sandbox> as Sandbox;
const signal = new AbortController().signal;

type Turn = { text?: string; stopReason?: string; failure?: Error };

const agentWith = ({ text = "", stopReason = "end_turn", failure }: Turn) => {
  const close = vi.fn(async () => {});
  const open = vi.fn<Pick<AcpAgent, "open">["open"]>(
    async () =>
      ({
        capabilities: { loadSession: true },
        close,
        prompt: async (
          _text: string,
          { onEvent }: { onEvent: (event: unknown) => void },
        ): Promise<{ stopReason: string }> => {
          onEvent({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
          if (failure) throw failure;
          return { stopReason };
        },
      }) as never,
  );
  return { agent: { open }, open, close };
};

type Run = ConstructorParameters<typeof AgentTests>[0]["run"];

const setUp = (run: Run, cleanUp = async () => {}) => {
  const finishAgentTest = vi.fn(async () => {});
  const lent = new LentValues();
  lent.add("KEY", "sk-secret-value");
  const plane = { finishAgentTest };
  return { finishAgentTest, tests: new AgentTests({ plane, lent, run, cleanUp }) };
};

const ready = async (tests: AgentTests) => {
  await vi.waitFor(() => expect(tests.isFree()).toBe(true));
  return tests;
};

const untilAborted: Run = (_test, testSignal) =>
  new Promise((_, reject) => {
    testSignal.addEventListener("abort", () => reject(new Error("aborted")));
  });

describe("AgentTests", () => {
  it("gives the capabilities when the agent replies", async () => {
    const { agent } = agentWith({ text: "OK" });

    expect(await askAgent(agent, { sandbox }, signal)).toEqual({ loadSession: true });
  });

  it("opens the agent with the default model of the instance", async () => {
    const { agent, open } = agentWith({ text: "OK" });

    await askAgent(agent, { sandbox, model: "small" }, signal);

    expect(open.mock.calls[0]?.[0].model).toBe("small");
  });

  it("opens the agent with no write and no shell permission", async () => {
    const { agent, open } = agentWith({ text: "OK" });

    await askAgent(agent, { sandbox }, signal);

    expect(open.mock.calls[0]?.[0].permissions).toEqual({
      write: false,
      shell: false,
      network: [],
    });
  });

  it("fails with the reply when the reply is a provider error", async () => {
    const { agent } = agentWith({ text: "Invalid API key" });

    await expect(askAgent(agent, { sandbox }, signal)).rejects.toThrow(
      "Unexpected reply: Invalid API key",
    );
  });

  it("adds the reply when the turn fails", async () => {
    const failure = new Error("Authentication required");
    const { agent } = agentWith({ text: "Invalid API key", failure });

    await expect(askAgent(agent, { sandbox }, signal)).rejects.toThrow(
      "Authentication required: Invalid API key",
    );
  });

  it("names a turn without a reply", async () => {
    const { agent } = agentWith({ failure: new Error("Authentication required") });

    await expect(askAgent(agent, { sandbox }, signal)).rejects.toThrow(
      "Authentication required: (no reply)",
    );
  });

  it("fails when the reply stops early", async () => {
    const { agent } = agentWith({ text: "OK", stopReason: "max_tokens" });

    await expect(askAgent(agent, { sandbox }, signal)).rejects.toThrow(
      "The reply stopped: max_tokens",
    );
  });

  it("closes the session after a failed reply", async () => {
    const { agent, close } = agentWith({ text: "Invalid API key" });

    await askAgent(agent, { sandbox }, signal).catch(() => {});

    expect(close).toHaveBeenCalledOnce();
  });

  it("takes no test during its clean up", () => {
    const { tests } = setUp(
      async () => ({}),
      () => new Promise(() => {}),
    );

    expect(tests.isFree()).toBe(false);
  });

  it("takes a test after a failed clean up", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { tests } = setUp(
      async () => ({}),
      async () => {
        throw new Error("No Docker");
      },
    );

    await ready(tests);

    expect(error).toHaveBeenCalledOnce();
  });

  it("sends the capabilities of a test that passed", async () => {
    const { tests, finishAgentTest } = setUp(async () => ({ loadSession: true }));
    await ready(tests);

    tests.start(test);

    await vi.waitFor(() =>
      expect(finishAgentTest).toHaveBeenCalledWith("token-1", {
        capabilities: { loadSession: true },
      }),
    );
  });

  it("sends the error of a test that failed", async () => {
    const { tests, finishAgentTest } = setUp(async () => {
      throw new Error("No command");
    });
    await ready(tests);

    tests.start(test);

    await vi.waitFor(() =>
      expect(finishAgentTest).toHaveBeenCalledWith("token-1", { error: "No command" }),
    );
  });

  it("masks a value that the limit of an error would cut", async () => {
    const { tests, finishAgentTest } = setUp(async () => {
      throw new Error(`${"x".repeat(maxRunErrorLength - 5)}sk-secret-value`);
    });
    await ready(tests);

    tests.start(test);

    await vi.waitFor(() =>
      expect(finishAgentTest).toHaveBeenCalledWith("token-1", {
        error: `${"x".repeat(maxRunErrorLength - 5)}***`,
      }),
    );
  });

  it("is not free during a test", async () => {
    const { tests } = setUp(() => new Promise(() => {}));
    await ready(tests);

    tests.start(test);

    expect(tests.isFree()).toBe(false);
  });

  it("is free after a test", async () => {
    const { tests } = setUp(async () => ({}));
    await ready(tests);

    tests.start(test);

    await ready(tests);
  });

  it("names the runner stop in the result of a test", async () => {
    const { tests, finishAgentTest } = setUp(untilAborted);
    await ready(tests);
    tests.start(test);

    await tests.stop();

    expect(finishAgentTest).toHaveBeenCalledWith("token-1", {
      error: "The runner stopped during the test",
    });
  });

  it("names the time limit of a test", async () => {
    const limit = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(limit.signal);
    const { tests, finishAgentTest } = setUp(untilAborted);
    await ready(tests);
    tests.start(test);

    limit.abort();

    await vi.waitFor(() =>
      expect(finishAgentTest).toHaveBeenCalledWith("token-1", {
        error: "The test took more than 15 minutes",
      }),
    );
  });

  it("logs a result that the server refuses, and sends it once", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { tests, finishAgentTest } = setUp(async () => ({}));
    finishAgentTest.mockRejectedValueOnce(refused("No authority"));
    await ready(tests);

    tests.start(test);
    await ready(tests);

    expect(finishAgentTest).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });
});
