import { join } from "node:path";

import { readTextFile } from "@halinka/utils/fs";
import { isServerUrl, normalizeUrl, serverUrlHint } from "@halinka/utils/serverUrl";
import { parseRepoConfig, repoConfigPath } from "@halinka/workflow";

import { problemLine } from "./apiFailure";
import { fail, failWithError, failWithUsage } from "./args";
import { readLocalServerUrl } from "./localServerUrl";
import { readLogins } from "./logins";

export type ServerOptions = {
  usage: string;
  // What the command sends to the server; a command that sends nothing allows http.
  sends?: string;
};

export type ResolveServerOptions = ServerOptions & {
  // The server when the person selects none: this machine, the server of a repo, or none.
  fallback: "local" | "none" | { repo: string };
};

export const isLoopback = (hostname: string) =>
  hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);

export const parseServer = async (value: string, { usage, sends }: ServerOptions) => {
  const url = value === "local" ? await readLocalServerUrl().catch(failWithError) : value;
  if (!isServerUrl(url)) {
    return failWithUsage(`The server must be "local" or ${serverUrlHint}. Got "${value}".`, usage);
  }
  const server = normalizeUrl(url);
  const { protocol, hostname, host } = new URL(server);
  if (sends !== undefined && protocol !== "https:" && !isLoopback(hostname)) {
    fail(`Halinka does not send ${sends} to ${host} without TLS. Use an https URL.`);
  }
  return server;
};

const readServerOfRepo = async (root: string) => {
  const source = await readTextFile(join(root, repoConfigPath)).catch(failWithError);
  if (source === undefined) return fail(`${root} has no ${repoConfigPath}. Run halinka init.`);
  const config = parseRepoConfig(source);
  if (config.ok) return config.value.server;
  return fail(`${repoConfigPath} is not valid: ${config.problems.map(problemLine).join(", ")}.`);
};

// A cloned repo selects its server: it must not get the path and the inputs before a login.
const refuseServerOfRepo = async (server: string, root: string) => {
  const { tokens } = await readLogins().catch(failWithError);
  if (!isLoopback(new URL(server).hostname) && !tokens[server]) {
    fail(`${root} selects the server ${server}. To use it: halinka login --server ${server}`);
  }
};

export const resolveServer = async (flag: string | undefined, options: ResolveServerOptions) => {
  const { fallback } = options;
  const chosen =
    flag ?? process.env.HALINKA_SERVER_URL ?? (await readLogins().catch(failWithError)).current;
  if (chosen !== undefined) return parseServer(chosen, options);
  if (fallback === "local") return parseServer("local", options);
  if (fallback === "none") return failWithUsage("Give --server <url>.", options.usage);
  const server = await parseServer(await readServerOfRepo(fallback.repo), options);
  await refuseServerOfRepo(server, fallback.repo);
  return server;
};
