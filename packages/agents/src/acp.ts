import {
  ClientSideConnection,
  ndJsonStream,
  type PermissionOption,
  PROTOCOL_VERSION,
  RequestError,
  type NewSessionRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type StopReason,
} from "@agentclientprotocol/sdk";
import type { SandboxProcess } from "@halinka/sandbox";
import type { StepPermissions } from "@halinka/workflow";

import type {
  Agent,
  AgentContext,
  AgentEvent,
  AgentSession,
  AgentTurn,
  CreateReportChannel,
  PromptOptions,
  ReportChannel,
} from "./agent";
import { checkPermission } from "./permissionPolicy";

export const agentTestQuestion = "Reply with the single word OK and nothing else.";

const cancelGraceMs = 5000;
const maxStderrTailChars = 4096;

const select = (
  options: PermissionOption[],
  kinds: PermissionOption["kind"][],
): RequestPermissionResponse => {
  const option = kinds
    .map((kind) => options.find((option) => option.kind === kind))
    .find((option) => option !== undefined);
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
};

const answer = ({ toolCall, options }: RequestPermissionRequest, permissions: StepPermissions) =>
  checkPermission(toolCall, permissions)
    ? select(options, ["reject_once", "reject_always"])
    : select(options, ["allow_once", "allow_always"]);

const valuesOf = (option: SessionConfigOption) =>
  option.type === "select"
    ? option.options.flatMap((item) => ("group" in item ? item.options : [item]))
    : [];

// The SDK puts the message of an error that the agent throws in `data.details`.
const withDetails = (error: unknown) => {
  if (!(error instanceof RequestError)) return error;
  const { data } = error;
  return data && typeof data === "object" && "details" in data && typeof data.details === "string"
    ? new RequestError(error.code, `${error.message}: ${data.details}`, data)
    : error;
};

class AcpConnection {
  private stderr = "";
  private readonly exited: Promise<never>;
  private readonly connection: ClientSideConnection;
  private onTurnEvent: ((event: AgentEvent) => void) | undefined;

  constructor(
    private readonly agent: SandboxProcess,
    private readonly stop: () => void,
    permissions: StepPermissions,
  ) {
    const stderrRead = agent.stderr
      .pipeThrough(new TextDecoderStream())
      .pipeTo(
        new WritableStream({
          write: (chunk) => {
            this.stderr = (this.stderr + chunk).slice(-maxStderrTailChars);
          },
        }),
      )
      .catch(() => {});
    this.exited = agent.exited.then(async (code): Promise<never> => {
      await stderrRead;
      const tail = this.stderr.trim();
      throw new Error(`The agent exited with code ${code}${tail ? `: ${tail}` : ""}`);
    });
    this.exited.catch(() => {});

    this.connection = new ClientSideConnection(
      () => ({
        sessionUpdate: ({ update }) => this.onTurnEvent?.(update),
        requestPermission: (request) => answer(request, permissions),
      }),
      ndJsonStream(agent.stdin, agent.stdout),
    );
    this.connection.signal.addEventListener("abort", stop);
  }

  // No turn listens during a load, so the updates that replay the session are dropped.
  async handshake(request: NewSessionRequest, model?: string, loadSessionId?: string) {
    const { agentCapabilities: capabilities = {} } = await this.untilExit(
      // The agent uses its own file and terminal tools in the sandbox.
      this.connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
    );
    const { sessionId, isLoaded, configOptions } = await this.openSession(
      request,
      capabilities.loadSession ? loadSessionId : undefined,
    );
    if (model) await this.selectModel(sessionId, model, configOptions ?? []);
    return { sessionId, isLoaded, capabilities };
  }

  private async openSession(request: NewSessionRequest, loadSessionId?: string) {
    if (loadSessionId) {
      try {
        const { configOptions } = await this.untilExit(
          this.connection.loadSession({ ...request, sessionId: loadSessionId }),
        );
        return { sessionId: loadSessionId, isLoaded: true, configOptions };
      } catch (error) {
        // The agent refuses a session whose files are gone.
        if (!(error instanceof RequestError)) throw error;
      }
    }
    const { sessionId, configOptions } = await this.untilExit(this.connection.newSession(request));
    return { sessionId, isLoaded: false, configOptions };
  }

  // At each open: a new process of the agent can start with its default model.
  private async selectModel(sessionId: string, model: string, options: SessionConfigOption[]) {
    const option = options.find(({ category }) => category === "model");
    if (!option) throw new Error(`The agent offers no models, so it cannot use ${model}`);
    try {
      await this.untilExit(
        this.connection.setSessionConfigOption({ sessionId, configId: option.id, value: model }),
      );
    } catch (error) {
      if (!(error instanceof RequestError)) throw error;
      const offered = valuesOf(option).map(({ value }) => value);
      throw new Error(
        `The agent refused the model ${model}: ${error.message}. It offers: ${offered.join(", ")}`,
      );
    }
  }

  async prompt(sessionId: string, text: string, { signal, interrupt, onEvent }: PromptOptions) {
    let grace: NodeJS.Timeout | undefined;
    const cancelTurn = () => {
      this.connection.cancel({ sessionId }).catch(() => {});
    };
    const cancel = () => {
      cancelTurn();
      grace = setTimeout(this.stop, cancelGraceMs);
    };
    this.onTurnEvent = onEvent;
    signal.addEventListener("abort", cancel);
    interrupt?.addEventListener("abort", cancelTurn);
    try {
      const request = this.connection.prompt({ sessionId, prompt: [{ type: "text", text }] });
      if (interrupt?.aborted) cancelTurn();
      const { stopReason } = await this.untilExit(request);
      return stopReason;
    } finally {
      this.onTurnEvent = undefined;
      signal.removeEventListener("abort", cancel);
      interrupt?.removeEventListener("abort", cancelTurn);
      clearTimeout(grace);
    }
  }

  // After the processes of the agent ended, so another engine can use the workspace.
  async close() {
    this.stop();
    await this.agent.stopped;
  }

  // The connection closes with stdout, often before the exit code arrives.
  private untilExit<T>(request: Promise<T>) {
    return Promise.race([
      request.catch((error: unknown) =>
        this.connection.signal.aborted ? this.exited : Promise.reject(withDetails(error)),
      ),
      this.exited,
    ]);
  }
}

type AcpSessionOptions = {
  sessionId: string;
  isLoaded: boolean;
  capabilities: Record<string, unknown>;
};

class AcpSession implements AgentSession {
  readonly sessionId: string;
  readonly isLoaded: boolean;
  readonly capabilities: Record<string, unknown>;

  constructor(
    private readonly connection: AcpConnection,
    private readonly channel: ReportChannel,
    { sessionId, isLoaded, capabilities }: AcpSessionOptions,
  ) {
    this.sessionId = sessionId;
    this.isLoaded = isLoaded;
    this.capabilities = capabilities;
  }

  async prompt(text: string, options: PromptOptions): Promise<AgentTurn> {
    options.signal.throwIfAborted();
    let stopReason: StopReason;
    try {
      stopReason = await this.connection.prompt(this.sessionId, text, options);
    } catch (error) {
      // The read deletes the files that the failed turn wrote.
      await this.read().catch(() => {});
      throw error;
    }
    return { stopReason, ...(await this.read()) };
  }

  async close() {
    const closed = await Promise.allSettled([this.connection.close(), this.channel.close()]);
    const failed = closed.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  // A failed read can leave the files of the turn, so the session ends: a new open gets a new folder.
  private async read() {
    try {
      return await this.channel.read();
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }
}

export type AgentLaunch = {
  env?: Record<string, string>;
  providerHosts?: string[];
  credentialNames?: string[];
};

export type AgentStart = { command: string[]; launch: AgentLaunch };

// `readStart` runs at each open, so an open uses the credentials of that time.
export class AcpAgent implements Agent {
  constructor(
    private readonly readStart: () => Promise<AgentStart>,
    private readonly createReportChannel: CreateReportChannel,
    private readonly toolsMeta?: (tools: string[]) => Record<string, unknown>,
  ) {}

  async open(
    { sandbox, reportShape, permissions, sessionId, model, tools, mcp_servers = [] }: AgentContext,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const processControl = new AbortController();
    const stop = () => processControl.abort();
    signal.addEventListener("abort", stop);
    let agent: SandboxProcess | undefined;
    try {
      const { command, launch } = await this.readStart();
      signal.throwIfAborted();
      const { env, providerHosts = [], credentialNames } = launch;
      const { network: stepHosts } = permissions;
      const network = stepHosts === true ? true : [...providerHosts, ...stepHosts];
      const [spawned, created] = await Promise.allSettled([
        sandbox.spawn(command, {
          env,
          network,
          credentialNames,
          user: "agent",
          signal: processControl.signal,
        }),
        this.createReportChannel(sandbox, reportShape),
      ]);
      if (spawned.status === "fulfilled") agent = spawned.value;
      if (spawned.status === "rejected" || created.status === "rejected") {
        if (created.status === "fulfilled") await created.value.close().catch(() => {});
        throw spawned.status === "rejected"
          ? spawned.reason
          : (created as PromiseRejectedResult).reason;
      }
      const channel = created.value;
      const connection = new AcpConnection(spawned.value, stop, permissions);
      const stepServers = mcp_servers.map(({ args = [], ...server }) => ({
        ...server,
        args,
        env: [],
      }));
      const request = {
        cwd: sandbox.workspaceFolder,
        mcpServers: [channel.mcpServer, ...stepServers],
        _meta: tools && this.toolsMeta?.(tools),
      };
      const session = await connection
        .handshake(request, model, sessionId)
        .catch(async (error: unknown) => {
          await channel.close().catch(() => {});
          throw error;
        });
      return new AcpSession(connection, channel, session);
    } catch (error) {
      stop();
      // The engine may use the workspace again at once.
      await agent?.stopped;
      throw error;
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }
}
