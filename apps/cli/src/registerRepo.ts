import { codeOf } from "@halinka/protocol";
import { readRunnerKey } from "@halinka/runner/runnerKey";
import { createApiClient, isUnauthorized, ORPCError } from "@halinka/server/client";
import { errorMessage } from "@halinka/utils/errors";
import { halinkaHome } from "@halinka/utils/halinkaHome";
import type { Result } from "@halinka/utils/result";

import { logInHint, readToken } from "./logins";

export type RegisterRepoOptions = {
  // A person who may run a repo may not have the right to register it.
  isListedFirst?: boolean;
};

export type RegisterProblem = {
  kind: "no_runner_key" | "no_login" | "unreachable" | "refused";
  reason: string;
};

const registerTimeoutMs = 5000;

const problem = (
  kind: RegisterProblem["kind"],
  reason: string,
): Result<number, RegisterProblem> => ({ ok: false, problems: [{ kind, reason }] });

const notRunnerHint = (server: string) =>
  `This machine is not a runner of the server. Make it a runner: halinka runner --server ${server}`;

const failure = (error: unknown, server: string) => {
  if (isUnauthorized(error)) return problem("no_login", logInHint(server));
  if (error instanceof ORPCError) return problem("refused", error.message);
  const isRefused = error instanceof Error && codeOf(error.cause) === "ECONNREFUSED";
  return problem(
    isRefused ? "unreachable" : "refused",
    `${server} did not answer. Check that the server runs.`,
  );
};

export const registerRepo = async (
  server: string,
  root: string,
  { isListedFirst = false }: RegisterRepoOptions = {},
): Promise<Result<number, RegisterProblem>> => {
  let publicKey: string | undefined;
  try {
    publicKey = (await readRunnerKey(halinkaHome()))?.publicKey;
  } catch (error) {
    return problem("refused", errorMessage(error));
  }
  if (publicKey === undefined) return problem("no_runner_key", notRunnerHint(server));
  const api = createApiClient(server, { token: await readToken(server) });
  const signal = AbortSignal.timeout(registerTimeoutMs);
  try {
    const [runners, repos] = await Promise.all([
      api.runners.list(undefined, { signal }),
      isListedFirst ? api.repos.list(undefined, { signal }) : [],
    ]);
    const runner = runners.find((candidate) => candidate.publicKey === publicKey);
    if (!runner) return problem("refused", notRunnerHint(server));
    const known = repos.find(({ runnerId, path }) => runnerId === runner.id && path === root);
    if (known) return { ok: true, value: known.id };
    const repo = await api.repos.register({ runnerId: runner.id, path: root }, { signal });
    return { ok: true, value: repo.id };
  } catch (error) {
    return failure(error, server);
  }
};
