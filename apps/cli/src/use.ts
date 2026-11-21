import { failWithError, failWithUsage, parseCommandWithPositionals } from "./args";
import { logInHint, readLogins, updateLogins } from "./logins";
import { chooseServer, parseServer, readSelection } from "./serverChoice";

const usage = `Usage: halinka use [local|url]

Selects the server of the next commands. "local" is the server of this machine.
With no server, shows the selected server and the logins of this machine.`;

const priorityNote = async () => {
  const selection = await readSelection(undefined).catch(failWithError);
  return selection?.source === "HALINKA_SERVER_URL"
    ? ` HALINKA_SERVER_URL selects ${selection.value}. It has priority over halinka use.`
    : "";
};

const show = async () => {
  const { url, source } = await chooseServer(undefined, { usage });
  console.log(
    source
      ? `${source} selects ${url} for the next commands.`
      : `The next commands use the server of this machine: ${url}.`,
  );
  const { tokens } = await readLogins().catch(failWithError);
  for (const [server, { login }] of Object.entries(tokens)) {
    console.log(`Logged in to ${server} as ${login}.`);
  }
};

export const use = async (args: string[]) => {
  const { positionals } = parseCommandWithPositionals(args, {}, usage);
  const [value] = positionals;
  if (positionals.length > 1) return failWithUsage("Give one server.", usage);
  if (value === undefined) return show();
  if (value === "local") {
    await updateLogins((logins) => ({ ...logins, current: undefined })).catch(failWithError);
    console.log(`halinka use selects the server of this machine.${await priorityNote()}`);
    return;
  }
  const server = await parseServer(value, { usage });
  let hasLogin = false;
  await updateLogins((logins) => {
    hasLogin = Boolean(logins.tokens[server]);
    return { ...logins, current: server };
  }).catch(failWithError);
  const hint = hasLogin ? "" : ` ${logInHint(server)}`;
  console.log(`halinka use selects ${server}.${hint}${await priorityNote()}`);
};
