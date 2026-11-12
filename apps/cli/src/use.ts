import { failWithError, failWithUsage, parseCommandWithPositionals } from "./args";
import { logInHint, updateLogins } from "./logins";
import { parseServer } from "./serverChoice";

const usage = `Usage: halinka use <url|repo>

Selects the server of the next commands. "repo" uses the server of each repo again.`;

export const use = async (args: string[]) => {
  const { positionals } = parseCommandWithPositionals(args, {}, usage);
  const [value] = positionals;
  if (value === undefined || positionals.length > 1) {
    return failWithUsage("Give one server.", usage);
  }
  if (value === "repo") {
    await updateLogins((logins) => ({ ...logins, current: undefined })).catch(failWithError);
    console.log("Each repo uses its own server.");
    return;
  }
  const server = await parseServer(value, { usage });
  await updateLogins((logins) => {
    if (!logins.tokens[server]) throw new Error(logInHint(server));
    return { ...logins, current: server };
  }).catch(failWithError);
  console.log(`The next commands use ${server}.`);
};
