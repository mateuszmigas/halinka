import { hasCode, type SandboxKind } from "@halinka/protocol";
import type { Runner } from "@halinka/runner";
import { errorMessage, isAbortError } from "@halinka/utils/errors";

import { fail } from "./args";

// sysexits: a service manager starts the runner again after EX_TEMPFAIL, not after EX_CONFIG.
const exTempFail = 75;
const exConfig = 78;

const updateHint = "Install the version of the server, then start the runner again.";

const unitUpdateHint = "Run halinka runner install again: it installs the version of the server.";

const selfUpdateHint = "The service starts the runner again with the build of the server.";

type RefusalOptions = { isUnderUnit?: boolean; canUpdate?: boolean };

export const failWithRefusal = (
  prefix: string,
  error: unknown,
  { isUnderUnit = false, canUpdate = false }: RefusalOptions = {},
): never => {
  const message = `${prefix}${errorMessage(error)}`;
  if (hasCode(error, "update_needed")) {
    if (!isUnderUnit) return fail(`${message}. ${updateHint}`, exTempFail);
    // Without self-update, 75 would start the same build again.
    return canUpdate
      ? fail(`${message}. ${selfUpdateHint}`, exTempFail)
      : fail(`${message}. ${unitUpdateHint}`, exConfig);
  }
  return fail(message, hasCode(error, "refused") ? exConfig : 1);
};

// Each version prints it, as `install` finds it in the log of a build that can be another version.
export const connectedMark = " connected to ";

export const connectedLineOf = (name: string, server: string, serverId: string | undefined) =>
  `runner "${name}"${connectedMark}${server}, server id ${serverId}`;

type StartRunnerOptions = RefusalOptions & { stopBeforeFail?: () => Promise<void> };

// `false` after a Ctrl+C before the server accepted the runner.
export const startRunner = async (
  runner: Runner,
  { stopBeforeFail = async () => {}, ...options }: StartRunnerOptions = {},
) => {
  try {
    await runner.start();
    return true;
  } catch (error) {
    if (isAbortError(error)) return false;
    await stopBeforeFail();
    return failWithRefusal("", error, options);
  }
};

export const warnOfWorktree = (kind: SandboxKind) => {
  if (kind !== "worktree") return;
  console.warn(
    "Warning: in a worktree, steps run without a sandbox. Agents and commands run as your user, with your files and credentials.",
  );
};
