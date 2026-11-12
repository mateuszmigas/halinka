import { join } from "node:path";

import { InMemoryTransport } from "@halinka/protocol/inMemoryTransport";
import { Runner } from "@halinka/runner";
import { loadOrCreateRunnerKey, runnerKeyPath } from "@halinka/runner/runnerKey";
import { hostGit } from "@halinka/sandbox/host";
import { readTextFile } from "@halinka/utils/fs";
import { halinkaHome } from "@halinka/utils/halinkaHome";
import { parseRepoConfig, repoConfigPath } from "@halinka/workflow";

import { parseCommandArgs, portFlag, parsePort, parseRunnerFlags, runnerFlags } from "./args";
import { problemLines } from "./definitionFiles";
import { LocalServer } from "./localServer";
import { registerRepo } from "./registerRepo";
import { startRunner, warnOfWorktree } from "./runnerStart";
import { safeText } from "./safeText";
import { stopOnSignals } from "./signals";

const usage = `Usage: halinka start [options]

Options:
${portFlag.usage}
${runnerFlags.usage}`;

const parseFlags = (args: string[]) => {
  const flags = parseCommandArgs(
    args,
    {
      ...portFlag.option,
      ...runnerFlags.option,
    },
    usage,
  );
  return { port: parsePort(flags.port, usage), runnerOptions: parseRunnerFlags(flags, usage) };
};

const findLocalRepo = async () => {
  const root = await hostGit(process.cwd()).findRoot();
  if (!root) return undefined;
  const source = await readTextFile(join(root, repoConfigPath));
  if (source === undefined) return undefined;
  const config = parseRepoConfig(source);
  if (!config.ok) {
    const problems = problemLines(repoConfigPath, config.problems).join("\n  ");
    console.error(
      safeText(`${repoConfigPath} is not valid. start registers no repo.\n  ${problems}`),
    );
    return undefined;
  }
  return config.value.server === "local" ? root : undefined;
};

export const start = async (args: string[]) => {
  const { port, runnerOptions } = parseFlags(args);
  // Before the server starts: a Ctrl+C also stops the git child.
  const repo = await findLocalRepo();
  const key = await loadOrCreateRunnerKey(halinkaHome());
  const local = await LocalServer.start(port);
  const { server } = local;
  const runner = new Runner(new InMemoryTransport(server, key.publicKey), {
    home: halinkaHome(),
    build: local.build,
    ...runnerOptions,
  });

  const registered = await server.registerLocalRunner(key);
  if (!registered || registered.refusal) {
    const path = runnerKeyPath(halinkaHome());
    console.error(
      registered
        ? `The server refuses the runner "${registered.name}" of this machine: ${registered.refusal}.`
        : `Another runner is named "${key.name}". Set another "name" in ${path}, or restore the runner.json of that runner.`,
    );
    await local.stop();
    process.exit(1);
  }
  stopOnSignals(async () => {
    await runner.stop();
    await local.stop();
  });
  local.announce();
  if (!(await startRunner(runner, { stopBeforeFail: () => local.stop() }))) return;
  console.log(
    `runner connected, runs in ${runnerOptions.sandboxKind}, server id ${runner.serverId}`,
  );
  warnOfWorktree(runnerOptions.sandboxKind);
  void runner.closed.then((refusal) => {
    if (refusal) console.error(`The server ended the connection of the runner: ${refusal.message}`);
  });

  if (repo) {
    const registration = await registerRepo(server.url, repo);
    console.log(
      registration.ok
        ? `registered the repo ${repo}`
        : `did not register the repo ${repo}: ${registration.problems.map(({ reason }) => reason).join("\n")}`,
    );
  }
};
