import { createApiClient, ORPCError } from "@halinka/server/client";
import { errorMessage } from "@halinka/utils/errors";
import { poll } from "@halinka/utils/poll";

import { fail, failWithError, failWithUsage, parseCommandArgs } from "./args";
import { updateLogins } from "./logins";
import { parseServer } from "./serverChoice";

const usage = `Usage: halinka login --server <url>

Logs this machine in to a server. A person who is logged in to its portal approves the code.

Options:
  --server <url>  The URL of the server`;

const pollMs = 5000;

const parseServerFlag = (value: string | undefined) => {
  if (!value) return failWithUsage("Give --server <url>.", usage);
  return parseServer(value, { usage, sends: "a login" });
};

const waitForApproval = (
  api: ReturnType<typeof createApiClient>,
  server: string,
  deviceCode: string,
) =>
  poll(async () => {
    const answer = await api.cliLogin.exchange({ deviceCode }).catch((error: unknown) => {
      if (error instanceof ORPCError && error.defined) return fail(error.message);
      console.error(`${server} did not answer: ${errorMessage(error)}. Halinka tries again.`);
      return { status: "pending" as const };
    });
    return answer.status === "approved" ? answer.token : undefined;
  }, pollMs);

export const login = async (args: string[]) => {
  const flags = parseCommandArgs(args, { server: { type: "string" } }, usage);
  const server = await parseServerFlag(flags.server);
  const api = createApiClient(server);
  const { deviceCode, userCode } = await api.cliLogin
    .start()
    .catch((error: unknown) => fail(`${server} refused the login: ${errorMessage(error)}`));
  console.log(`Code: ${userCode}`);
  console.log(`Open ${server}/cli-login?code=${userCode}, and approve this code.`);
  const token = await waitForApproval(api, server, deviceCode);
  const { user } = await createApiClient(server, { token }).session();
  await updateLogins((logins) => ({
    ...logins,
    current: server,
    tokens: { ...logins.tokens, [server]: { token, login: user?.login ?? "" } },
  })).catch(failWithError);
  console.log(`Logged in to ${server} as ${user?.login}.`);
};
