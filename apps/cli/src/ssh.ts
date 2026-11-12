import { connectStream } from "@halinka/protocol/webSocket";
import { createApiClient, runSshPath } from "@halinka/server/client";
import { errorMessage } from "@halinka/utils/errors";
import { parseSshHostWorkflowRunId, sshHostPattern } from "@halinka/utils/sshHost";

import { fail, failWithUsage, parseCommandWithPositionals } from "./args";
import { readToken } from "./logins";
import { pinHostKey } from "./pinHostKey";
import { resolveServer } from "./serverChoice";

const usage = `Usage: halinka ssh <run> [options]
       halinka ssh config [options]
       halinka ssh known-hosts <run> [options]

<run> is the id of a run or a host name of the config. ssh starts this command as its ProxyCommand.
"config" writes the block for ~/.ssh/config, which lets VS Code Remote-SSH open a run.
"known-hosts" gives ssh the key of the runner of the run. It saves the key at the first use.
The container must run, and the run must be finished or expired.

Options:
  --server <url>  The server (default: HALINKA_SERVER_URL, then the server of halinka use)`;

const quoted = (text: string) => `"${text.replaceAll("%", "%%")}"`;

// ssh starts the command from any folder, so `--import` needs a path too.
const thisCommand = () => {
  const options = process.execArgv.map((option, index, all) =>
    all[index - 1] === "--import" ? import.meta.resolve(option) : option,
  );
  return [process.execPath, ...options, process.argv[1]!].map(quoted).join(" ");
};

const configBlock = (server: string) =>
  [
    `Host ${sshHostPattern(server)}`,
    // ssh gives the command to a shell with the host name as it is; ssh 9.6 also refuses shell characters in it.
    `  ProxyCommand ${thisCommand()} ssh '%n' --server ${quoted(server)}`,
    `  KnownHostsCommand ${thisCommand()} ssh known-hosts '%n' --server ${quoted(server)}`,
    "  StrictHostKeyChecking yes",
    "  UserKnownHostsFile /dev/null",
    "  GlobalKnownHostsFile /dev/null",
    "  PubkeyAuthentication no",
    "  ForwardAgent no",
    "  ForwardX11 no",
    "  LogLevel ERROR",
    "",
  ].join("\n");

const relay = async (server: string, workflowRunId: number) => {
  const token = await readToken(server);
  const { stream, refusalReason } = await connectStream(
    new URL(runSshPath(workflowRunId), server),
    token ? { authorization: `Bearer ${token}` } : {},
  );
  process.stdin.pipe(stream);
  stream.pipe(process.stdout);
  const reason = await refusalReason;
  if (reason) fail(reason);
  process.exit(0);
};

const printKnownHost = async (server: string, host: string, workflowRunId: number) => {
  const api = createApiClient(server, { token: await readToken(server) });
  const { runnerId, sshHostKey } = await api.runs.sshHostKey({ id: workflowRunId });
  console.log(`${host} ${await pinHostKey(server, runnerId, sshHostKey)}`);
};

export const ssh = async (args: string[]) => {
  const { values, positionals } = parseCommandWithPositionals(
    args,
    { server: { type: "string" } },
    usage,
  );
  const [first, second] = positionals as [string?, string?];
  const target = first === "known-hosts" ? second : first;
  if (!target || positionals.length > (first === "known-hosts" ? 2 : 1)) {
    return failWithUsage("Give one run.", usage);
  }
  try {
    const server = await resolveServer(values.server, {
      usage,
      sends: "a token",
      fallback: "none",
    });
    if (target === "config") {
      process.stdout.write(configBlock(server));
      return;
    }
    const workflowRunId = parseSshHostWorkflowRunId(target, server);
    if (workflowRunId === undefined) return failWithUsage(`There is no run in "${target}".`, usage);
    if (first === "known-hosts") await printKnownHost(server, target, workflowRunId);
    else await relay(server, workflowRunId);
  } catch (error) {
    fail(errorMessage(error));
  }
};
