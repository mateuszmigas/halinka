import type { McpServer, SessionUpdate, StopReason } from "@agentclientprotocol/sdk";
import type { AgentQuestions } from "@halinka/protocol";
import type { Sandbox } from "@halinka/sandbox";
import type { AgentStep, ReportShape, StepPermissions, StepReport } from "@halinka/workflow";

export type AgentEvent = SessionUpdate;

// `questions`: the agent called `ask_human` in the turn
export type TurnReport = {
  report?: StepReport;
  reportProblems?: string;
  questions?: AgentQuestions;
  questionProblems?: string;
};

export type AgentTurn = { stopReason: StopReason } & TurnReport;

// `sessionId`: a session to load; without it, or when the load fails, a new session
export type AgentContext = {
  sandbox: Sandbox;
  reportShape: ReportShape;
  permissions: StepPermissions;
  sessionId?: string;
} & Pick<AgentStep, "model" | "tools" | "mcp_servers">;

export type ReportChannel = {
  mcpServer: McpServer;
  read: () => Promise<TurnReport>;
  close: () => Promise<void>;
};

export type CreateReportChannel = (
  sandbox: Sandbox,
  reportShape: ReportShape,
) => Promise<ReportChannel>;

// `signal` also stops the agent when the turn takes too long; `interrupt` only cancels the turn.
export type PromptOptions = {
  signal: AbortSignal;
  interrupt?: AbortSignal;
  onEvent: (event: AgentEvent) => void;
};

// `isLoaded`: the session continues the session of `AgentContext.sessionId`
export type AgentSession = {
  sessionId: string;
  isLoaded: boolean;
  prompt: (text: string, options: PromptOptions) => Promise<AgentTurn>;
  close: () => Promise<void>;
};

export type Agent = {
  open: (context: AgentContext, signal: AbortSignal) => Promise<AgentSession>;
};
