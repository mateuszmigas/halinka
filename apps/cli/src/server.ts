import { parseCommandArgs, portFlag, parsePort } from "./args";
import { LocalServer } from "./localServer";
import { stopOnSignals } from "./signals";

const usage = `Usage: halinka server [options]

Options:
${portFlag.usage}
  --host <address>                   The address to listen on (default: 127.0.0.1). Another address needs a login`;

export const server = async (args: string[]) => {
  const flags = parseCommandArgs(args, { ...portFlag.option, host: { type: "string" } }, usage);
  const local = await LocalServer.start(parsePort(flags.port, usage), {
    hasLogin: true,
    ...(flags.host && { host: flags.host }),
  });
  stopOnSignals(() => local.stop());
  local.announce();
};
