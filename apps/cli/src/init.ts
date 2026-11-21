import { join, relative, resolve } from "node:path";

import { cancel, intro, isCancel, log, note, outro, select } from "@clack/prompts";
import { agentPresets } from "@halinka/presets";
import { findDevcontainers, setUpRepo } from "@halinka/runner/repoSetup";
import { errorMessage } from "@halinka/utils/errors";
import { pathExists } from "@halinka/utils/fs";
import { newDevcontainerPath, smokeAgent } from "@halinka/workflow";

import { fail as exit, failWithUsage, parseCommandArgs } from "./args";
import { findRepoRoot } from "./findRepoRoot";
import { logInHint, readToken } from "./logins";
import { registerRepo } from "./registerRepo";
import { chooseServer } from "./serverChoice";

const usage = `Usage: halinka init [options]

Options:
  --server <local|url>               The server that registers the repo (default: HALINKA_SERVER_URL,
                                     then halinka use, then the server of this machine)
  --devcontainer <path|create|none>  The devcontainer that workflows use
  --yes                              Use the default for each value that you do not give`;

const smokeVariables = agentPresets[smokeAgent].credentials
  .map(({ variable }) => variable)
  .join("|");

type ResolveDevcontainerOptions = { isInteractive: boolean };

const fail = (message: string) => failWithUsage(message, usage);

const answer = <T>(value: T) => {
  if (isCancel(value)) {
    cancel("Cancelled.");
    process.exit(1);
  }
  return value as Exclude<T, symbol>;
};

// A path is relative to the current folder, as in other commands.
const parseDevcontainerFlag = (value: string | undefined, found: string[], root: string) => {
  if (value === undefined || value === "none") return value;
  if (value === "create") {
    return found.includes(newDevcontainerPath)
      ? fail(`${newDevcontainerPath} exists. Use --devcontainer ${newDevcontainerPath}.`)
      : value;
  }
  const path = relative(root, resolve(value));
  return (
    found.find((item) => item === path) ??
    fail(`No devcontainer at ${value}. Found: ${found.join(", ") || "none"}.`)
  );
};

const chooseDevcontainer = async (found: string[]) => {
  const create = {
    value: "create",
    label: `create ${newDevcontainerPath}`,
    hint: "a base image, edit it to add your tools",
  };
  const options = found.length > 0 ? found.map((path) => ({ value: path, label: path })) : [create];
  return answer(
    await select({
      message: "Which devcontainer will workflows use?",
      options: [
        ...options,
        { value: "none", label: "none", hint: "workflows run only in worktrees" },
      ],
    }),
  );
};

const resolveDevcontainer = async (
  flag: string | undefined,
  found: string[],
  { isInteractive }: ResolveDevcontainerOptions,
) => {
  const [first] = found;
  if (!flag && first && (found.length === 1 || !isInteractive)) {
    log.info(`Uses ${first}`);
    return first;
  }
  const choice = flag ?? (isInteractive ? await chooseDevcontainer(found) : "create");
  if (choice === "none") return undefined;
  return choice === "create" ? newDevcontainerPath : choice;
};

export const init = async (args: string[]) => {
  const flags = parseCommandArgs(
    args,
    {
      server: { type: "string" },
      devcontainer: { type: "string" },
      yes: { type: "boolean", default: false },
    },
    usage,
  );
  const isInteractive = !flags.yes;
  const root = await findRepoRoot(undefined);
  const [isInitialized, found] = await Promise.all([
    pathExists(join(root, ".halinka")),
    findDevcontainers(root),
  ]);
  if (isInitialized)
    exit("This repo already has .halinka/. Edit its files to change the settings.");
  const flagDevcontainer = parseDevcontainerFlag(flags.devcontainer, found, root);
  const isDevcontainerAsked = !flagDevcontainer && found.length !== 1;
  if (isInteractive && !process.stdin.isTTY && isDevcontainerAsked) {
    fail("The input is not a terminal. Give --devcontainer, or --yes.");
  }
  const { url: server, isLocal } = await chooseServer(flags.server, {
    usage,
    sends: "the path of the repo",
  });

  intro("halinka init");
  const devcontainer = await resolveDevcontainer(flagDevcontainer, found, { isInteractive });

  const { files } = await setUpRepo({ repoPath: root, devcontainer }).catch((error: unknown) =>
    exit(errorMessage(error)),
  );
  for (const path of files) log.success(`Wrote ${path}`);

  const name = isLocal ? "local" : server;
  const registration = await registerRepo(server, root);
  const [problem] = registration.ok ? [] : registration.problems;
  if (registration.ok) log.success(`Registered the repo on ${name}`);
  const isCoveredByNextSteps =
    problem?.kind === "no_runner_key" ||
    problem?.kind === "no_login" ||
    (isLocal && problem?.kind === "unreachable");
  if (problem && !isCoveredByNextSteps) {
    log.warn(`${name} did not register the repo: ${problem.reason}`);
  }

  const runsIn = devcontainer ? "" : " --runs-in worktree";
  const steps: string[] = [];
  const needsLogin =
    problem !== undefined && (problem.kind === "no_login" || !(await readToken(server)));
  if (!isLocal && needsLogin) steps.push(logInHint(server));
  if (!registration.ok) {
    steps.push(
      isLocal
        ? `Start Halinka in this repo. This registers the repo: halinka start${runsIn}. If Halinka runs in another folder, halinka run smoke in this repo registers it`
        : `For a repo that the server reads from GitHub: commit these files, and merge them to the default branch. For a local repo: make this machine a runner, and ask an Admin to approve it: halinka runner --server ${server}${runsIn}. Then halinka run smoke --server ${server} registers the repo`,
    );
  }
  if (devcontainer) {
    steps.push(
      `Add a key of ${smokeAgent}, the agent of the smoke workflow: the Agents page of the portal, or halinka agent key ${smokeAgent} <${smokeVariables}>`,
    );
  }
  steps.push("Open the portal and run the smoke workflow");
  note(steps.join("\n"), "Next steps");
  outro("Done.");
};
