import { join, relative, resolve } from "node:path";

import { isInsideFolder, isRealPathInside } from "@halinka/utils/fs";
import { isRecord } from "@halinka/utils/isRecord";

export type RealFolders = {
  treeFolder: string;
  workspaceFolder: string;
};

// The debuggers of the Go, C++ and Rust templates need it.
export const allowedCapabilities = new Set(["SYS_PTRACE"]);

// Shared propagation shows the mounts of the container on the host.
export const allowedPropagations = new Set(["private", "rprivate"]);

const reservedLabelPrefixes = ["halinka.", "com.docker.compose.", "devcontainer."];

export const isString = (value: unknown) => typeof value === "string";

export const text = (value: unknown) => (isString(value) ? value : JSON.stringify(value));

export const isReservedLabel = (label: string) =>
  reservedLabelPrefixes.some((prefix) => label.startsWith(prefix));

export const reachesHost = (host: string) => host.includes("host-gateway");

export const movedBindSource = (source: string, { treeFolder, workspaceFolder }: RealFolders) =>
  isInsideFolder(source, treeFolder)
    ? join(workspaceFolder, relative(treeFolder, source))
    : undefined;

type CheckInsideOptions = { folder: string; folderName: string; base?: string };

export class Problems {
  private readonly problems: Promise<string | undefined>[] = [];

  add(problem: string) {
    this.problems.push(Promise.resolve(problem));
  }

  checkInside(
    where: string,
    path: unknown,
    { folder, folderName, base = "/" }: CheckInsideOptions,
  ) {
    this.problems.push(
      (async () => {
        if (isString(path) && (await isRealPathInside(resolve(base, path), folder))) return;
        return `${where}: ${text(path)} is outside the ${folderName}`;
      })(),
    );
  }

  recordOf(where: string, value: unknown) {
    if (value === undefined || value === null) return {};
    if (isRecord(value)) return value;
    this.add(`${where} must be an object`);
    return {};
  }

  keysOf(where: string, value: unknown, allowed: ReadonlySet<string>) {
    const record = this.recordOf(where, value);
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) this.add(`${where}: ${key} is not allowed`);
    }
    return record;
  }

  listOf(where: string, value: unknown) {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value as unknown[];
    this.add(`${where} must be a list`);
    return [];
  }

  stringsOf(where: string, value: unknown) {
    const list = [value ?? []].flat();
    if (list.every(isString)) return list;
    this.add(`${where} must be a list of strings`);
    return [];
  }

  valuesOf(where: string, value: unknown, isAllowed: (value: string) => boolean) {
    for (const item of this.stringsOf(where, value)) {
      if (!isAllowed(item)) this.add(`${where}: ${item} is not allowed`);
    }
  }

  matches(where: string, value: unknown, pattern: RegExp) {
    if (value !== undefined && !(isString(value) && pattern.test(value))) {
      this.add(`${where}: ${text(value)} is not allowed`);
    }
  }

  async all() {
    const problems = await Promise.all(this.problems);
    return problems.filter((problem) => problem !== undefined);
  }
}
