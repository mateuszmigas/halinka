import { homedir } from "node:os";
import { resolve } from "node:path";

import { isFolder } from "@halinka/utils/fs";

import { fail, failWithUsage } from "./args";
import { parseServer } from "./serverChoice";

type ParseServerFlagOptions = { isInsecure: boolean; usage: string };

export const runnerConnectionFlags = {
  usage: [
    "  --server <url>  The URL of the server",
    "  --enroll-stdin  Read the enrollment token from stdin",
    "  --root <path>   A folder that the server can reach on this machine (default: the home folder). Repeat it for more",
    "  --insecure      Allow http:// and ws:// to a host that is not this machine (for tests)",
  ].join("\n"),
  option: {
    server: { type: "string" },
    "enroll-stdin": { type: "boolean", default: false },
    root: { type: "string", multiple: true, default: [] as string[] },
    insecure: { type: "boolean", default: false },
  },
} as const;

export const readFolderRoots = async (values: string[]) => {
  const roots = values.length > 0 ? values.map((value) => resolve(value)) : [homedir()];
  for (const root of roots) {
    if (!(await isFolder(root))) fail(`--root ${root} is not a folder.`);
  }
  return roots;
};

// The API and the runner socket share the URL: `ws:` is `http:` for the API.
export const parseServerFlag = (
  value: string | undefined,
  { isInsecure, usage }: ParseServerFlagOptions,
) => {
  if (!value) return failWithUsage("Give --server <url>.", usage);
  const url = URL.parse(value);
  if (url?.protocol === "ws:" || url?.protocol === "wss:") {
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  }
  return parseServer(url?.href ?? value, {
    usage,
    sends: isInsecure ? undefined : "the runner's requests",
  });
};
