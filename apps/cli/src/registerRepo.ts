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

export type RegisterProblem = { kind: "no_runner_key" | "refused"; reason: string };

const registerTimeoutMs = 5000;

const refused = (
  reason: string,
  kind: RegisterProblem["kind"] = "refused",
): Result<number, RegisterProblem> => ({ ok: false, problems: [{ kind, reason }] });

const notRunnerHint = (server: string) =>
  `This machine is not a runner of the server. Make it a runner: halinka runner --server ${server}`;

const failureReason = (error: unknown, server: string) => {
  if (isUnauthorized(error)) return logInHint(server);
  if (error instanceof ORPCError) return error.message;
  return `${server} did not answer. Check that the server runs.`;
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
    return refused(errorMessage(error));
  }
  if (publicKey === undefined) return refused(notRunnerHint(server), "no_runner_key");
  const api = createApiClient(server, { token: await readToken(server) });
  const signal = AbortSignal.timeout(registerTimeoutMs);
  try {
    const [runners, repos] = await Promise.all([
      api.runners.list(undefined, { signal }),
      isListedFirst ? api.repos.list(undefined, { signal }) : [],
    ]);
    const runner = runners.find((candidate) => candidate.publicKey === publicKey);
    if (!runner) return refused(notRunnerHint(server));
    const known = repos.find(({ runnerId, path }) => runnerId === runner.id && path === root);
    if (known) return { ok: true, value: known.id };
    const repo = await api.repos.register({ runnerId: runner.id, path: root }, { signal });
    return { ok: true, value: repo.id };
  } catch (error) {
    return refused(failureReason(error, server));
  }
};
