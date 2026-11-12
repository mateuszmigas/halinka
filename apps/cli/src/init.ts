import { join, relative, resolve } from "node:path";

import { cancel, intro, isCancel, log, note, outro, select, text } from "@clack/prompts";
import { findDevcontainers, setUpRepo } from "@halinka/runner/repoSetup";
import { errorMessage } from "@halinka/utils/errors";
import { pathExists } from "@halinka/utils/fs";
import { isServerUrl, serverUrlHint } from "@halinka/utils/serverUrl";
import { newDevcontainerPath } from "@halinka/workflow";

import { fail as exit, failWithUsage, parseCommandArgs } from "./args";
import { findRepoRoot } from "./findRepoRoot";
import { registerRepo } from "./registerRepo";
import { parseServer, type ServerOptions } from "./serverChoice";

const usage = `Usage: halinka init [options]

Options:
  --server <local|url>               The server that this repo uses
  --devcontainer <path|create|none>  The devcontainer that workflows use
  --yes                              Use the default for each value that you do not give`;

const serverOptions: ServerOptions = { usage, sends: "the path of the repo" };

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

const chooseServer = async () => {
  const choice = answer(
    await select({
      message: "Which Halinka server will you use?",
      options: [
        { value: "local", label: "local", hint: "halinka start on this machine" },
        { value: "remote", label: "remote", hint: "a team server at a URL" },
      ],
    }),
  );
  if (choice === "local") return choice;
  const url = answer(
    await text({
      message: "What is the URL of the server?",
      placeholder: "https://halinka.example.com",
      validate: (value) => (isServerUrl(value ?? "") ? undefined : `Enter ${serverUrlHint}.`),
    }),
  );
  return url;
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

  const missing = [
    !flags.server && "--server",
    !flagDevcontainer && found.length !== 1 && "--devcontainer",
  ].filter(Boolean);
  if (isInteractive && !process.stdin.isTTY && missing.length > 0) {
    fail(`The input is not a terminal. Give ${missing.join(", ")}, or --yes.`);
  }

  intro("halinka init");
  const choice = flags.server ?? (isInteractive ? await chooseServer() : "local");
  const serverUrl = await parseServer(choice, serverOptions);
  const server = choice === "local" ? choice : serverUrl;
  const devcontainer = await resolveDevcontainer(flagDevcontainer, found, { isInteractive });

  const { files } = await setUpRepo({ repoPath: root, server, devcontainer }).catch(
    (error: unknown) => exit(errorMessage(error)),
  );
  for (const path of files) log.success(`Wrote ${path}`);

  const registration = await registerRepo(serverUrl, root);
  if (registration.ok) log.success(`Registered the repo on ${server}`);
  // The next steps say how to make this machine a runner.
  else if (registration.problems[0]?.kind === "refused") {
    log.warn(`${server} did not register the repo: ${registration.problems[0].reason}`);
  }

  const runsIn = devcontainer ? "" : " --runs-in worktree";
  const steps: string[] = [];
  if (server !== "local") steps.push(`Log in: halinka login --server ${server}`);
  if (!registration.ok) {
    steps.push(
      server === "local"
        ? `Start Halinka in this repo. This registers the repo: halinka start${runsIn}`
        : `For a repo that the server reads from GitHub: commit these files, and merge them to the default branch. For a local repo: make this machine a runner, and ask an Admin to approve it: halinka runner --server ${server}${runsIn}. Then halinka run registers the repo`,
    );
  }
  if (devcontainer) {
    steps.push(
      "Give your agent credentials for devcontainer runs: the Agents page of the portal, or halinka agent key <agent> <variable>",
    );
  }
  steps.push("Open the portal and run the smoke workflow");
  note(steps.join("\n"), "Next steps");
  outro("Done.");
};
