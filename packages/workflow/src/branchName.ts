import { errorMessage } from "@halinka/utils/errors";
import type { Result } from "@halinka/utils/result";

import { interpolate, replaceExpressions } from "./expressions";
import type { Inputs } from "./inputs";
import type { Workflow } from "./workflow";

// the main rules of `git check-ref-format --branch`
const invalidBranchName =
  /[\p{Cc} ~^:?*[\\]|\.\.|@\{|\/\/|^[-/.]|[/.]$|\/\.|\.lock(\/|$)|^@$|^HEAD$/u;

export const isBranchName = (name: string) => name !== "" && !invalidBranchName.test(name);

// The values of the inputs can still make the name invalid, so run creation checks it again.
export const isBranchNameTemplate = (template: string) =>
  isBranchName(replaceExpressions(template, "x"));

export const branchNameHint =
  "Use a git branch name: no spaces, .., @{, //, ~ ^ : ? * [ \\, and no / or . at the start or end";

export const resolveBranchName = (
  { branch }: Workflow,
  inputs: Inputs,
): Result<string | undefined> => {
  if (!branch) return { ok: true, value: undefined };
  try {
    const name = interpolate(branch.name, { inputs, steps: {} });
    if (isBranchName(name)) return { ok: true, value: name };
    return { ok: false, problems: [`The branch name "${name}" is not valid. ${branchNameHint}`] };
  } catch (error) {
    return { ok: false, problems: [`Check the branch name: ${errorMessage(error)}`] };
  }
};
