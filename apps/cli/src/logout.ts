import { createApiClient, isUnauthorized } from "@halinka/server/client";
import { errorMessage } from "@halinka/utils/errors";

import { fail, failWithError, parseCommandArgs } from "./args";
import { readLogins, updateLogins } from "./logins";
import { resolveServer } from "./serverChoice";

const usage = `Usage: halinka logout [options]

Ends the login of this machine on a server.

Options:
  --server <url>  The server (default: HALINKA_SERVER_URL, then the server of halinka use)`;

export const logout = async (args: string[]) => {
  const flags = parseCommandArgs(args, { server: { type: "string" } }, usage);
  const server = await resolveServer(flags.server, { usage, sends: "a token", fallback: "none" });
  const token = (await readLogins().catch(failWithError)).tokens[server]?.token;
  if (!token) return fail(`This machine has no login on ${server}.`);
  await createApiClient(server, { token })
    .cliLogin.logout()
    .catch((error: unknown) => {
      // The server ended this token already.
      if (isUnauthorized(error)) return;
      fail(`The login stays: ${server} did not end it: ${errorMessage(error)}`);
    });
  await updateLogins((logins) => {
    const { [server]: saved, ...tokens } = logins.tokens;
    // A login of another command after the read keeps its new token.
    if (saved?.token !== token) return logins;
    const { current, ...rest } = logins;
    return { ...rest, ...(current !== server && { current }), tokens };
  }).catch(failWithError);
  console.log(`Logged out of ${server}.`);
};
