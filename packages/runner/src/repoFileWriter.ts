import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { conflict, invalidDefinitions, invalidInput, type RepoFileWrite } from "@halinka/protocol";
import { errnoCode } from "@halinka/utils/errors";
import {
  ensureFolder,
  isRealPathInside,
  findRealPath,
  isFile,
  isInsideFolder,
  readBinaryFile,
} from "@halinka/utils/fs";
import { hashOf } from "@halinka/utils/hash";
import { maxFileMib, mib } from "@halinka/utils/repoFiles";
import { SerialQueue } from "@halinka/utils/serialQueue";
import { definitionsFolder } from "@halinka/workflow";

import { openDefinitions } from "./repoFiles";

const isRefusedSegment = (segment: string) =>
  segment === "" || segment === "." || segment === ".." || segment.includes("\0");

const segmentsOf = (path: string) => {
  const [first, ...rest] = path.split("/");
  if (first !== definitionsFolder || rest.length === 0 || rest.some(isRefusedSegment))
    return undefined;
  return rest;
};

const isDenied = (error: unknown) => {
  const code = errnoCode(error);
  return code === "EACCES" || code === "EPERM";
};

const createFolder = (path: string, name: string) =>
  ensureFolder(path).catch((error: unknown) => {
    const code = errnoCode(error);
    if (code === "ENOTDIR" || code === "EEXIST") {
      throw invalidInput(`${name} is not a folder`);
    }
    if (isDenied(error)) throw invalidDefinitions(`${name} cannot be written`);
    throw error;
  });

const writeRepoFile = async (input: RepoFileWrite) => {
  const { repoPath, path, source, expectedHash } = input;
  const segments = segmentsOf(path);
  if (!segments) throw invalidInput(`${path} is not a file in ${definitionsFolder}/`);
  const bytes = Buffer.from(source, "utf8");
  if (bytes.byteLength > maxFileMib * mib) {
    throw invalidInput(`${path} is larger than ${maxFileMib} MiB`);
  }
  const { root, folder: existingFolder } = await openDefinitions(repoPath);
  const folder = existingFolder ?? join(root, definitionsFolder);
  if (!existingFolder) await createFolder(folder, definitionsFolder);
  const full = join(folder, ...segments);
  const parent = dirname(full);
  if (!(await isRealPathInside(parent, folder))) {
    throw invalidInput(`${path} points outside ${definitionsFolder}/`);
  }
  await createFolder(parent, dirname(path));
  const real = await findRealPath(full);
  if (real && !isInsideFolder(real, folder)) {
    throw invalidInput(`${path} points outside ${definitionsFolder}/`);
  }
  if (real && !(await isFile(real))) throw invalidInput(`${path} is not a file`);
  const current = real ? await readBinaryFile(real) : undefined;
  const currentHash = current ? hashOf(current) : undefined;
  const hash = hashOf(bytes);
  if (currentHash === hash) return { hash };
  if (expectedHash === undefined) {
    if (currentHash) throw conflict(`${path} already exists`);
  } else if (!currentHash) {
    throw conflict(`${path} does not exist`);
  } else if (currentHash !== expectedHash) {
    throw conflict(`${path} changed since it was read`);
  }
  await writeFile(full, bytes, { flag: expectedHash === undefined ? "wx" : "w" }).catch(
    (error: unknown) => {
      if (errnoCode(error) === "EEXIST") throw conflict(`${path} already exists`);
      if (isDenied(error)) throw invalidDefinitions(`${path} cannot be written`);
      throw error;
    },
  );
  return { hash };
};

// Writes run one at a time, so two writes with one expected hash cannot both pass the check.
export class RepoFileWriter {
  private readonly writes = new SerialQueue();

  write(input: RepoFileWrite) {
    return this.writes.run(() => writeRepoFile(input));
  }
}
