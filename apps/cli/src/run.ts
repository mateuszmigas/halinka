import { type ApiError, createApiClient, isUnauthorized } from "@halinka/server/client";
import { errorMessage } from "@halinka/utils/errors";

import { formatApiFailure } from "./apiFailure";
import { fail, failWithUsage, parseCommandWithPositionals } from "./args";
import { findRepoRoot } from "./findRepoRoot";
import { logInHint, readToken } from "./logins";
import { registerRepo } from "./registerRepo";
import { RunFollower } from "./runFollower";
import { RunPrinter } from "./runPrinter";
import { safeText } from "./safeText";
import { resolveServer } from "./serverChoice";
import { stopOnSignals } from "./signals";

const usage = `Usage: halinka run <workflow> [options]

Asks the server for a run of this repo, and follows it. Ctrl+C stops the follow; the run continues.

Options:
  --input <name=value>   An input of the workflow (repeat it)
  --repo <path>          The repo, if it is not the repo of the current folder
  --server <local|url>   The server (default: HALINKA_SERVER_URL, then halinka use, then server in .halinka/config.yml)`;

const readTimeoutMs = 10_000;

// 128 + SIGINT: not a result of the run.
const followStoppedExitCode = 130;

const parseInputs = (values: string[]) =>
  Object.fromEntries(
    values.map((value) => {
      const separator = value.indexOf("=");
      return separator > 0
        ? [value.slice(0, separator), value.slice(separator + 1)]
        : failWithUsage(`--input must be name=value. Got "${value}".`, usage);
    }),
  );

export const run = async (args: string[]) => {
  const { values: flags, positionals } = parseCommandWithPositionals(
    args,
    {
      input: { type: "string", multiple: true, default: [] as string[] },
      repo: { type: "string" },
      server: { type: "string" },
    },
    usage,
  );
  const [workflow] = positionals;
  if (workflow === undefined || positionals.length > 1) {
    return failWithUsage("Give one workflow.", usage);
  }
  const inputs = parseInputs(flags.input);
  const root = await findRepoRoot(flags.repo);
  const server = await resolveServer(flags.server, {
    usage,
    sends: "a run",
    fallback: { repo: root },
  });
  const registration = await registerRepo(server, root, { isListedFirst: true });
  if (!registration.ok)
    return fail(safeText(registration.problems.map(({ reason }) => reason).join("\n")));
  const repoId = registration.value;
  const api = createApiClient(server, { token: await readToken(server) });
  const stopping = new AbortController();
  stopOnSignals(async () => stopping.abort());
  const { id } = await api.runs
    .create({ repoId, workflow, inputs }, { signal: stopping.signal })
    .catch((error: ApiError) => {
      if (!stopping.signal.aborted) return fail(safeText(formatApiFailure(error, server)));
      console.error(`The server can have created the run. Look in the portal: ${server}/runs`);
      return process.exit(followStoppedExitCode);
    });

  const runUrl = `${server}/runs/${id}`;
  const printer = new RunPrinter(process.stdout, process.stderr);
  printer.line(`Run ${id}: ${runUrl}`);
  const follower = new RunFollower({
    api,
    workflowRunId: id,
    runUrl,
    printer,
    readTimeoutMs,
  });
  const ended = await follower
    .follow(stopping.signal)
    .catch((error: unknown) =>
      fail(safeText(isUnauthorized(error) ? logInHint(server) : errorMessage(error))),
    );

  if (!ended) {
    printer.line(`The run continues: ${runUrl}`);
    process.exitCode = followStoppedExitCode;
    return;
  }
  printer.line(`Run ${id}: ${ended.status}${ended.error ? `: ${ended.error}` : ""}`);
  process.exitCode = ended.status === "succeeded" ? 0 : 1;
};
