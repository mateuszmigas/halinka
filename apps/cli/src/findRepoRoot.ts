import { resolve } from "node:path";

import { hostGit } from "@halinka/sandbox/host";

import { fail, failWithError } from "./args";

export const findRepoRoot = async (flag: string | undefined) => {
  const path = resolve(flag ?? ".");
  const root = await hostGit(path).findRoot().catch(failWithError);
  return root ?? fail(`${path} is not in a git repository.`);
};
