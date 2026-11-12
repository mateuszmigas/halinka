import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { invalidInput, type RunnerCommands } from "@halinka/protocol";

import type { FolderRoots } from "./folderRoots";
import { isRepoRoot, requireAbsolute } from "./repoFiles";

export const maxFolders = 1000;

// A WebSocket message holds at most 16 MiB.
const maxListingBytes = 4 * 1024 * 1024;

export const listFolders: RunnerCommands["listFolders"] = async ({ path }) => {
  if (path !== undefined) requireAbsolute(path);
  const folder = resolve(path ?? homedir());
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => {
    throw invalidInput(`Halinka cannot open ${folder}`);
  });
  const names = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  let bytes = 0;
  const listed = names.slice(0, maxFolders).filter((name) => {
    bytes += JSON.stringify({ name, path: join(folder, name), isRepo: false }).length;
    return bytes <= maxListingBytes;
  });
  const [isFolderRepo, folders] = await Promise.all([
    isRepoRoot(folder),
    Promise.all(
      listed.map(async (name) => {
        const subfolder = join(folder, name);
        return { name, path: subfolder, isRepo: await isRepoRoot(subfolder) };
      }),
    ),
  ]);
  return {
    path: folder,
    parent: dirname(folder) === folder ? undefined : dirname(folder),
    isRepo: isFolderRepo,
    folders,
    isTruncated: names.length > listed.length,
  };
};

export const listFoldersIn =
  (roots: FolderRoots): RunnerCommands["listFolders"] =>
  async ({ path }) => {
    const folder = path ?? roots.first;
    await roots.requireInRoots(folder);
    const listing = await listFolders({ path: folder });
    return (await roots.isRoot(listing.path)) ? { ...listing, parent: undefined } : listing;
  };
