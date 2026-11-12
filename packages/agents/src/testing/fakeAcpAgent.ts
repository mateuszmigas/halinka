import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";

import {
  AgentSideConnection,
  type McpServerStdio,
  ndJsonStream,
  type NewSessionRequest,
  type PermissionOptionKind,
  PROTOCOL_VERSION,
  RequestError,
  type StopReason,
  type ToolKind,
} from "@agentclientprotocol/sdk";

export type FakeAction =
  | { say: string }
  | { echo: true }
  | { cwd: true }
  | { env: string }
  | { model: true }
  | { session: true }
  | { pid: true }
  | { write: { path: string; text: string } }
  | { permission: PermissionOptionKind[]; toolKind?: ToolKind; rawInput?: Record<string, unknown> }
  | { report: Record<string, unknown> }
  | { question: Record<string, unknown> }
  | { afterTurn: string }
  | { wait: true }
  | { hang: true }
  | { fail: string }
  | { exit: { code: number; stderr: string } }
  | { closeStdout: true }
  | { stop: StopReason };

export type FakeTurn = FakeAction[];

type AskOptions = { kind?: ToolKind; rawInput?: Record<string, unknown> };

// This script runs alone, so it cannot import `agentTestQuestion`.
const testQuestion = "Reply with the single word OK and nothing else.";
const scriptLinePattern = /^fake-agent:\s*(.+)$/m;
// A session keeps its place in the script across a close, as a real agent keeps its history.
const sessionsFolder = process.env.HALINKA_FAKE_AGENT_DIR;
const scriptFile = (sessionId: string) =>
  sessionsFolder && join(sessionsFolder, `${sessionId}.json`);
const forever = new Promise<never>(() => {});
const fakeModels = ["fake-small", "fake-large"];
const modelOffer = process.env.HALINKA_FAKE_AGENT_MODELS;
let currentModel = fakeModels[0]!;
let sessionFields = "";
let workspaceFolder = "";
let turns: FakeTurn[] = [];
let nextTurn = 0;
let promptText = "";
let turnCancelled = Promise.withResolvers<void>();
let halinkaServer: McpServerStdio | undefined;
let callTool: ((name: string, input: unknown) => Promise<unknown>) | undefined;

const connectStdioMcpClient = ({ command, args, env }: McpServerStdio) => {
  const server = spawn(command, args, {
    env: { ...process.env, ...Object.fromEntries(env.map(({ name, value }) => [name, value])) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pending = new Map<number, PromiseWithResolvers<unknown>>();
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure = error;
    for (const response of pending.values()) response.reject(error);
    pending.clear();
  };
  server.on("error", fail);
  server.on("exit", (code) => fail(new Error(`The MCP server exited with code ${code}`)));
  server.stdin.on("error", () => {});
  createInterface({ input: server.stdout }).on("line", (line) => {
    const { id, result, error } = JSON.parse(line) as {
      id: number;
      result?: unknown;
      error?: { message: string };
    };
    const response = pending.get(id);
    pending.delete(id);
    if (error) response?.reject(new Error(error.message));
    else response?.resolve(result);
  });
  let nextId = 0;
  const request = (method: string, params: unknown) => {
    if (failure) return Promise.reject(failure);
    const id = nextId++;
    const response = Promise.withResolvers<unknown>();
    pending.set(id, response);
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response.promise;
  };
  const ready = request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "fake-agent", version: "1" },
  }).then(() => request("tools/list", {}) as Promise<{ tools: { name: string }[] }>);
  return async (name: string, input: unknown) => {
    const { tools } = await ready;
    if (!tools.some((tool) => tool.name === name)) throw new Error(`The MCP server has no ${name}`);
    return request("tools/call", { name, arguments: input });
  };
};

const clientConnection = new AgentSideConnection(
  (connection) => {
    const select = (id: string, category: string, currentValue: string) => ({
      id,
      name: id,
      category,
      type: "select" as const,
      currentValue,
    });
    const configOptions = () => {
      const models = fakeModels.map((value) => ({ value, name: value }));
      const modeOption = {
        ...select("fake-mode", "mode", "normal"),
        options: [{ value: "normal", name: "normal" }],
      };
      if (modelOffer === "none") return [modeOption];
      const options =
        modelOffer === "grouped" ? [{ group: "all", name: "All", options: models }] : models;
      return [modeOption, { ...select("fake-model", "model", currentModel), options }];
    };
    const takeSession = ({ cwd, mcpServers, _meta }: NewSessionRequest) => {
      workspaceFolder = cwd;
      sessionFields = JSON.stringify({ servers: mcpServers, meta: _meta });
      halinkaServer = mcpServers.find(
        (server): server is McpServerStdio => server.name === "halinka" && "command" in server,
      );
    };
    const say = (sessionId: string, text: string) =>
      connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
    const ask = async (
      sessionId: string,
      kinds: PermissionOptionKind[],
      { kind, rawInput }: AskOptions = {},
    ) => {
      const { outcome } = await connection.requestPermission({
        sessionId,
        toolCall: { toolCallId: "1", title: "Run ls", kind, rawInput },
        options: kinds.map((kind) => ({ optionId: `${kind}-id`, kind, name: kind })),
      });
      return outcome.outcome === "selected" ? outcome.optionId : "cancelled";
    };
    const run = async (sessionId: string, action: FakeAction): Promise<StopReason | undefined> => {
      if ("say" in action) await say(sessionId, action.say);
      if ("echo" in action) await say(sessionId, promptText);
      if ("cwd" in action) await say(sessionId, workspaceFolder);
      if ("env" in action) await say(sessionId, process.env[action.env] ?? "");
      if ("model" in action) await say(sessionId, currentModel);
      if ("session" in action) await say(sessionId, sessionFields);
      if ("pid" in action) await say(sessionId, String(process.pid));
      if ("write" in action)
        await writeFile(join(workspaceFolder, action.write.path), action.write.text);
      if ("permission" in action) {
        const { permission, toolKind, rawInput } = action;
        await say(sessionId, await ask(sessionId, permission, { kind: toolKind, rawInput }));
      }
      if ("report" in action || "question" in action) {
        if (!halinkaServer) throw new Error("The session has no halinka MCP server");
        callTool ??= connectStdioMcpClient(halinkaServer);
        await ("report" in action
          ? callTool("report_result", action.report)
          : callTool("ask_human", action.question));
      }
      if ("afterTurn" in action) {
        // The client answers the request after it reads the update.
        setImmediate(() => {
          void say(sessionId, action.afterTurn)
            .then(() => ask(sessionId, ["reject_once"]))
            .then(() => writeFile(join(workspaceFolder, "after-turn-sent"), ""));
        });
      }
      if ("wait" in action) {
        await turnCancelled.promise;
        return "cancelled";
      }
      if ("hang" in action) await forever;
      if ("fail" in action) throw new Error(action.fail);
      if ("exit" in action) {
        const { code, stderr } = action.exit;
        process.stderr.write(stderr, () => process.exit(code));
        await forever;
      }
      if ("closeStdout" in action) {
        process.stdout.end();
        await forever;
      }
      if ("stop" in action) return action.stop;
      return undefined;
    };
    return {
      initialize: () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true },
      }),
      newSession: (request) => {
        takeSession(request);
        return { sessionId: `fake-session-${randomUUID()}`, configOptions: configOptions() };
      },
      setSessionConfigOption: ({ configId, value }) => {
        if (modelOffer === "exit") process.exit(3);
        if (configId !== "fake-model" || !fakeModels.includes(String(value)))
          throw RequestError.invalidParams();
        currentModel = String(value);
        return { configOptions: configOptions() };
      },
      loadSession: async (request) => {
        const { sessionId } = request;
        if (sessionId === "gone-session") throw RequestError.resourceNotFound(sessionId);
        takeSession(request);
        const file = scriptFile(sessionId);
        const saved = file && (await readFile(file, "utf8").catch(() => undefined));
        if (saved)
          ({ turns, nextTurn } = JSON.parse(saved) as { turns: FakeTurn[]; nextTurn: number });
        await say(sessionId, "replayed");
        return { configOptions: configOptions() };
      },
      authenticate: () => ({}),
      cancel: () => turnCancelled.resolve(),
      prompt: async ({ sessionId, prompt }) => {
        turnCancelled = Promise.withResolvers<void>();
        const text = prompt.flatMap((block) => (block.type === "text" ? [block.text] : []));
        promptText = text.join("\n");
        const script = scriptLinePattern.exec(promptText);
        if (script?.[1]) {
          turns = JSON.parse(script[1]) as FakeTurn[];
          nextTurn = 0;
        }
        const actions = turns[nextTurn++] ?? (promptText === testQuestion ? [{ say: "OK" }] : []);
        const file = scriptFile(sessionId);
        if (file) {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, JSON.stringify({ turns, nextTurn }));
        }
        for (const action of actions) {
          const stopReason = await run(sessionId, action);
          if (stopReason) return { stopReason };
        }
        return { stopReason: "end_turn" };
      },
    };
  },
  ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);

// Exit when the client closes: the open MCP server pipes keep the process alive.
void clientConnection.closed.then(() => process.exit());
