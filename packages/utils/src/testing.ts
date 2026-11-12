import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { onTestFinished, vi } from "vitest";

export const tempFolder = async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "halinka-")));
  onTestFinished(() => rm(path, { recursive: true, force: true }));
  return path;
};

export const writeFiles = async (folder: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(folder, path)), { recursive: true });
    await writeFile(join(folder, path), text);
  }
};

type FakedTimers = NonNullable<NonNullable<Parameters<typeof vi.useFakeTimers>[0]>["toFake"]>;

// The real timers come back when the test finishes.
export const fakeTimers = (toFake?: FakedTimers) => {
  vi.useFakeTimers(toFake && { toFake });
  onTestFinished(() => {
    vi.useRealTimers();
  });
};
