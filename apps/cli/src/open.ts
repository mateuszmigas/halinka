import { spawn } from "node:child_process";

import { parseCommandArgs } from "./args";
import { browserCommand } from "./browserCommand";
import { resolveServer } from "./serverChoice";

const usage = `Usage: halinka open [options]

Opens the portal of the server in the browser.

Options:
  --server <url>  The server (default: HALINKA_SERVER_URL, then halinka use, then the server of this machine)`;

export const open = async (args: string[]) => {
  const flags = parseCommandArgs(args, { server: { type: "string" } }, usage);
  const server = await resolveServer(flags.server, { usage, fallback: "local" });
  // Also for a machine with no browser, such as a VPS.
  console.log(server);
  const [command, commandArgs] = browserCommand(process.platform, server);
  const browser = spawn(command, commandArgs, { detached: true, stdio: "ignore" });
  browser.on("error", () => console.error("Open this address in a browser."));
  browser.unref();
};
