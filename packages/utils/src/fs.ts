import { randomUUID } from "node:crypto";
import {
  access,
  link,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, sep } from "node:path";

import { errnoCode } from "./errors";

// A symlink loop and a path through a file have no target either.
const undefinedIfMissing = (error: unknown): undefined => {
  const code = errnoCode(error);
  if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") return undefined;
  throw error;
};

export const pathExists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

export const isFile = (path: string) =>
  stat(path).then(
    (stats) => stats.isFile(),
    () => false,
  );

export const isFolder = (path: string) =>
  stat(path).then(
    (stats) => stats.isDirectory(),
    () => false,
  );

export const findRealPath = (path: string) => realpath(path).catch(undefinedIfMissing);

export const findNearestRealPath = async (path: string): Promise<string | undefined> => {
  const real = await findRealPath(path);
  if (real) return real;
  const parent = dirname(path);
  return parent === path ? undefined : findNearestRealPath(parent);
};

export const isInsideFolder = (path: string, folder: string) =>
  path === folder || path.startsWith(folder + sep);

export const isRealPathInside = async (path: string, folder: string) => {
  const real = await findNearestRealPath(path);
  return real !== undefined && isInsideFolder(real, folder);
};

export const findFileSize = (path: string) =>
  stat(path).then((stats) => (stats.isFile() ? stats.size : undefined), undefinedIfMissing);

export const readTextFile = (path: string) => readFile(path, "utf8").catch(undefinedIfMissing);

export const readPrivateFile = async (path: string) => {
  const text = await readTextFile(path);
  if (text === undefined) return undefined;
  const { mode } = await stat(path);
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    throw new Error(`Other users can access ${path}. Run: chmod 600 ${path}`);
  }
  return text;
};

export const readBinaryFile = (path: string) => readFile(path).catch(undefinedIfMissing);

export const ensureFolder = async (path: string) => {
  await mkdir(path, { recursive: true });
};

// The link publishes the complete file, so a reader never sees a part.
export const createFileOnce = async (path: string, content: string, mode = 0o644) => {
  const temp = `${path}.${randomUUID()}`;
  await writeFile(temp, content, { mode, flag: "wx" });
  try {
    await link(temp, path);
    return true;
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") throw error;
    return false;
  } finally {
    await rm(temp, { force: true });
  }
};

// The rename publishes the complete file, so a reader never sees a part.
export const replaceFile = async (path: string, content: string, mode = 0o644) => {
  const temp = `${path}.${randomUUID()}`;
  try {
    await writeFile(temp, content, { mode, flag: "wx" });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
};
