import { agentTestQuestion, type AcpAgent } from "@halinka/agents/acp";
import { findAgentPreset } from "@halinka/presets";
import {
  type AgentTestResult,
  type ClaimedAgentTest,
  type ControlPlane,
  maxRunErrorLength,
  textChunkOf,
} from "@halinka/protocol";
import type { Sandbox } from "@halinka/sandbox";
import { errorMessage } from "@halinka/utils/errors";

import type { LentValues } from "./lentValues";

// The image and the agent can take long to download.
const testTimeoutMs = 15 * 60_000;
const replyTimeoutMs = 2 * 60_000;

const readOnly = { write: false, shell: false, network: [] };

export const requireTestPreset = ({ preset }: ClaimedAgentTest) => {
  const found = findAgentPreset(preset);
  if (!found) throw new Error(`This runner has no agent ${preset}. Update the runner.`);
  return found;
};

// `initialize` alone never reaches the provider, so a wrong key passes it.
type AskAgentOptions = { sandbox: Sandbox; model?: string };

export const askAgent = async (
  agent: Pick<AcpAgent, "open">,
  { sandbox, model }: AskAgentOptions,
  signal: AbortSignal,
) => {
  await sandbox.assignWorkspace("agent");
  const limit = AbortSignal.any([signal, AbortSignal.timeout(replyTimeoutMs)]);
  const session = await agent.open(
    { sandbox, reportShape: {}, permissions: readOnly, model },
    limit,
  );
  let reply = "";
  try {
    const { stopReason } = await session.prompt(agentTestQuestion, {
      signal: limit,
      onEvent: (event) => {
        const chunk = textChunkOf(event);
        if (chunk?.sessionUpdate === "agent_message_chunk") reply += chunk.text;
      },
    });
    if (stopReason !== "end_turn") throw new Error(`The reply stopped: ${stopReason}`);
    // An agent can give a provider error as its message.
    if (!/\bok\b/i.test(reply)) throw new Error("Unexpected reply");
    return session.capabilities;
  } catch (error) {
    throw new Error(`${errorMessage(error)}: ${reply || "(no reply)"}`);
  } finally {
    await session.close();
  }
};

type AgentTestsDeps = {
  plane: Pick<ControlPlane, "finishAgentTest">;
  lent: Pick<LentValues, "mask">;
  run: (test: ClaimedAgentTest, signal: AbortSignal) => Promise<Record<string, unknown>>;
  // The server can give a test while this cleanup of a crashed process runs.
  cleanUp: () => Promise<void>;
};

// Outside the runner capacity, so a busy queue does not starve a test.
export class AgentTests {
  private readonly stopping = new AbortController();
  private current: Promise<void> | undefined;

  constructor(private readonly deps: AgentTestsDeps) {
    this.hold(
      deps.cleanUp().catch((error: unknown) => {
        console.error("The runner could not remove what an agent test left", error);
      }),
    );
  }

  isFree() {
    return this.current === undefined;
  }

  start(test: ClaimedAgentTest) {
    this.hold(this.run(test));
  }

  stop() {
    this.stopping.abort();
    return this.current;
  }

  private hold(work: Promise<void>) {
    this.current = work.finally(() => {
      this.current = undefined;
    });
  }

  private async run(test: ClaimedAgentTest) {
    const { plane } = this.deps;
    // The next `canTest` sync fails a test whose result does not arrive.
    const result = await this.execute(test);
    await plane.finishAgentTest(test.token, this.sent(result)).catch((error: unknown) => {
      console.error("The runner could not store the result of the agent test", error);
    });
  }

  // Mask first: a cut can leave a part of a value that no mask matches.
  private sent(result: AgentTestResult): AgentTestResult {
    if (!("error" in result)) return result;
    return { error: this.deps.lent.mask(result.error).slice(0, maxRunErrorLength) };
  }

  private async execute(test: ClaimedAgentTest): Promise<AgentTestResult> {
    const timeout = AbortSignal.timeout(testTimeoutMs);
    try {
      const signal = AbortSignal.any([this.stopping.signal, timeout]);
      return { capabilities: await this.deps.run(test, signal) };
    } catch (error) {
      if (this.stopping.signal.aborted) return { error: "The runner stopped during the test" };
      if (timeout.aborted)
        return { error: `The test took more than ${testTimeoutMs / 60_000} minutes` };
      return { error: errorMessage(error) };
    }
  }
}
