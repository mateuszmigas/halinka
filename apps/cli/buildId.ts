import { hashOf } from "@halinka/utils/hash";

export type BuildFile = { path: string; content: Uint8Array };

const byPath = (a: BuildFile, b: BuildFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

// The length prefix keeps path boundaries unambiguous.
export const buildIdOf = (files: BuildFile[]) =>
  hashOf(
    files
      .toSorted(byPath)
      .map(({ path, content }) => `${path.length}:${path}:${hashOf(content)}\n`)
      .join(""),
  );
