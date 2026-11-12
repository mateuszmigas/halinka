import { execFileSync } from "node:child_process";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";

import { tempFolder, writeFiles } from "@halinka/utils/testing";

import { runNetworksOf } from "../runNetwork";

export const image = "alpine:3.22";

// The outside host of a test is on a private Docker network.
export const dockerAddressPools = ["172.16.0.0/12", "192.168.0.0/16", "10.0.0.0/8"];

export const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8" }).trim();

export const startOutsideHost = (name: string) => {
  const host = `${name}-outside`;
  const server = "require('http').createServer((q, s) => s.end('outside\\n')).listen(8080)";
  const { egress } = runNetworksOf(name);
  docker(
    "run",
    "--detach",
    "--name",
    host,
    "--network",
    egress,
    "node:22-alpine",
    "node",
    "-e",
    server,
  );
  return { host, url: `http://${host}:8080/`, delete: () => docker("rm", "--force", host) };
};

export const tempFolderWith = async (files: Record<string, string>) => {
  const folder = await tempFolder();
  await writeFiles(folder, files);
  return folder;
};

export const checkFolders = async (treeFiles: Record<string, string> = {}) => {
  const treeFolder = await tempFolderWith(treeFiles);
  const workspaceFolder = await tempFolderWith({ "data/file": "" });
  await mkdir(join(treeFolder, ".devcontainer"), { recursive: true });
  await symlink("/etc", join(treeFolder, ".devcontainer/etc"));
  await symlink("/etc", join(workspaceFolder, "etc"));
  return { treeFolder, workspaceFolder };
};
