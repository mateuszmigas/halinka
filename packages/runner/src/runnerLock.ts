import { FileLocks } from "@halinka/utils/fileLocks";

// The server keeps one set of capabilities per runner, so one process per home.
export const takeRunnerLock = async (home: string, holderId: string) => {
  const release = await new FileLocks(home, holderId).tryTake("runner");
  if (!release)
    throw new Error(`Another Halinka process runs as the runner of ${home}. Stop it first.`);
  return release;
};
