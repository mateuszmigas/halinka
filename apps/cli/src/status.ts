import { isEndedOrExpired } from "@halinka/protocol";
import {
  type ApiError,
  type ApiOutputs,
  createApiClient,
  maxRunPageSize,
} from "@halinka/server/client";

import { formatApiFailure } from "./apiFailure";
import { fail, parseCommandArgs } from "./args";
import { readToken } from "./logins";
import { safeText } from "./safeText";
import { resolveServer } from "./serverChoice";

const usage = `Usage: halinka status [options]

Shows the server, its runners, its agents and the active runs.

Options:
  --server <url>  The server (default: HALINKA_SERVER_URL, then halinka use, then the server of this machine)`;

const requestTimeoutMs = 5000;

const section = (title: string, lines: string[]) =>
  [
    `${title}:`,
    ...(lines.length > 0 ? lines.map((line) => `  ${safeText(line)}`) : ["  none"]),
  ].join("\n");

const runnerLine = ({
  name,
  isConnected,
  state,
  sandboxKind,
}: ApiOutputs["runners"]["list"][number]) =>
  [name, isConnected ? "connected" : "not connected", state, sandboxKind]
    .filter(Boolean)
    .join("  ");

const agentLine = ({ preset, isEnabled, version }: ApiOutputs["agents"]["list"][number]) =>
  [preset, isEnabled ? "enabled" : "disabled", version].filter(Boolean).join("  ");

const runLine = ({
  id,
  status,
  workflowName,
  repoName,
}: ApiOutputs["runs"]["list"]["runs"][number]) => `#${id}  ${status}  ${workflowName}  ${repoName}`;

export const status = async (args: string[]) => {
  const flags = parseCommandArgs(args, { server: { type: "string" } }, usage);
  const server = await resolveServer(flags.server, { usage, sends: "a token", fallback: "local" });
  const api = createApiClient(server, { token: await readToken(server) });
  const signal = AbortSignal.timeout(requestTimeoutMs);
  const [runners, agents, { runs, nextBeforeId }] = await Promise.all([
    api.runners.list(undefined, { signal }),
    api.agents.list(undefined, { signal }),
    api.runs.list({ state: "active", limit: maxRunPageSize }, { signal }),
  ]).catch((error: ApiError) => fail(safeText(`${server}: ${formatApiFailure(error, server)}`)));
  console.log(
    [
      `Server: ${server}`,
      section("Runners", runners.map(runnerLine)),
      section("Agents", agents.map(agentLine)),
      section("Active runs", [
        ...runs.filter((run) => !isEndedOrExpired(run.status)).map(runLine),
        ...(nextBeforeId === undefined ? [] : ["More active runs exist than show here."]),
      ]),
    ].join("\n"),
  );
};
