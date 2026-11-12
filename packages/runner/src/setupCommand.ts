import type { ClaimedRun, ControlPlane, SetupSecrets } from "@halinka/protocol";
import { type Sandbox, maxStderrTailChars } from "@halinka/sandbox";
import { shortSha } from "@halinka/utils/git";

import { setUpTimeoutMs } from "./containers";
import type { Located, Workspaces } from "./workspaces";

// The first line of a cut stderr can hold a part of a value, and no mask matches a part.
const wholeLines = (stderr: string) =>
  stderr.length < maxStderrTailChars ? stderr : stderr.slice(stderr.indexOf("\n") + 1 || Infinity);

// At each start: the masks must hold also when the command does not run again.
export const lendSetupSecrets = async (
  { setupRun, lease }: ClaimedRun,
  plane: Pick<ControlPlane, "readSetupSecrets">,
  lent: { add: (name: string, value: string) => void },
): Promise<SetupSecrets> => {
  if (!setupRun) return { values: [], missing: [] };
  const secrets = await plane.readSetupSecrets(lease);
  for (const { variable, value } of secrets.values) lent.add(variable, value);
  return secrets;
};

type SetupCommandOptions = {
  secrets: SetupSecrets;
  sandbox: Sandbox;
  workspaces: Pick<Workspaces, "isSetUp" | "markSetUp" | "isOnBaseFiles">;
};

// Once per workspace and on the base files: the secret must not reach code that an agent changed.
export const runSetupCommand = async (
  run: Located<ClaimedRun>,
  { secrets: { values, missing }, sandbox, workspaces }: SetupCommandOptions,
  signal: AbortSignal,
) => {
  const {
    setupRun,
    setupNetwork = [],
    lease: { workflowRunId },
  } = run;
  if (!setupRun || (await workspaces.isSetUp(workflowRunId))) return;
  if (missing.length > 0) {
    throw new Error(
      `The server has no readable value of ${missing.join(", ")}. Set it again on the page of the repo.`,
    );
  }
  if (!(await workspaces.isOnBaseFiles(run, sandbox))) {
    throw new Error(
      `setup.run needs the base commit ${shortSha(run.baseSha)}, but the workspace is at another commit. Remove the workspace of the run.`,
    );
  }
  const { exitCode, stderr } = await sandbox.exec(["sh", "-c", setupRun], {
    env: Object.fromEntries(values.map(({ variable, value }) => [variable, value])),
    network: setupNetwork,
    timeoutMs: setUpTimeoutMs,
    isRepoCode: true,
    isOutputKept: false,
    signal,
  });
  if (exitCode !== 0) {
    throw new Error(`setup.run failed with exit code ${exitCode}: ${wholeLines(stderr).trim()}`);
  }
  await workspaces.markSetUp(workflowRunId);
};
