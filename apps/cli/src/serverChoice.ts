import { isServerUrl, normalizeUrl, serverUrlHint } from "@halinka/utils/serverUrl";

import { fail, failWithError, failWithUsage } from "./args";
import { readLocalServerUrl } from "./localServerUrl";
import { readLogins } from "./logins";

type ServerOptions = {
  usage: string;
  // What the command sends to the server; a command that sends nothing allows http.
  sends?: string;
};

export type ResolveServerOptions = ServerOptions & { fallback: "local" | "none" };

type SelectionSource = "--server" | "HALINKA_SERVER_URL" | "halinka use";

// `source` is undefined when no one selects a server, so the command uses this machine.
export type ChosenServer = { url: string; isLocal: boolean; source?: SelectionSource };

const isLoopback = (hostname: string) =>
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

// Not parsed: "local" or a URL as the person wrote it.
export const readSelection = async (flag: string | undefined) => {
  if (flag !== undefined) return { value: flag, source: "--server" as const };
  const variable = process.env.HALINKA_SERVER_URL;
  if (variable) return { value: variable, source: "HALINKA_SERVER_URL" as const };
  const { current } = await readLogins();
  return current === undefined ? undefined : { value: current, source: "halinka use" as const };
};

export const chooseServer = async (
  flag: string | undefined,
  options: ServerOptions,
): Promise<ChosenServer> => {
  const selection = await readSelection(flag).catch(failWithError);
  const value = selection?.value ?? "local";
  const url = await parseServer(value, options);
  const localUrl = await readLocalServerUrl().catch(() => undefined);
  const isLocal = value === "local" || (localUrl !== undefined && url === normalizeUrl(localUrl));
  return { url, isLocal, source: selection?.source };
};

export const resolveServer = async (flag: string | undefined, options: ResolveServerOptions) => {
  const selection = await readSelection(flag).catch(failWithError);
  if (!selection && options.fallback === "none") {
    return failWithUsage("Give --server <url>.", options.usage);
  }
  return parseServer(selection?.value ?? "local", options);
};
