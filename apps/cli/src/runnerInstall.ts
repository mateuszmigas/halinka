import { platform } from "node:os";
import { delimiter, dirname } from "node:path";

import type { SandboxKind } from "@halinka/protocol";
import { takeRunnerLock } from "@halinka/runner";
import { ensureFolder, isFile, readTextFile, replaceFile } from "@halinka/utils/fs";
import { poll } from "@halinka/utils/poll";

import { fail, failWithError, parseCommandArgs, parseRunnerFlags, runnerFlags } from "./args";
import { parseServerFlag, readFolderRoots, runnerConnectionFlags } from "./runnerArgs";
import { connectedMark } from "./runnerStart";
import {
  dockerEnvironmentOf,
  hasControlCharacter,
  isOwnWrapper,
  type RunnerUnit,
  runnerUnitNameOf,
  unitPathOf,
  unitTextOf,
  wrapperPath,
  wrapperTextOf,
} from "./runnerUnit";
import {
  clearUpdateFailures,
  installServerPackage,
  readRunnerHome,
  noPackageReason,
  readServerPackage,
  runBuild,
  switchCurrent,
} from "./runnerVersions";
import {
  checkDockerInUserManager,
  enableLinger,
  readInvocationLog,
  readUnitState,
  requireUserSystemd,
  runUnitJob,
  systemctl,
  unitFileOf,
  userUnitFolder,
} from "./userSystemd";

const usage = `Usage: halinka runner install --server <url> [options]

Installs the build of the server as a systemd user service of this user, enrolls the runner in this
terminal, and starts it. The service starts again after a reboot. Linux only. Run it again to install
the current build of the server or to change the options.

Options:
${runnerConnectionFlags.usage}
  --no-self-update  The service installs no build of the server; run install again for each update
${runnerFlags.usage}`;

const connectTimeoutMs = 60_000;
const statePollMs = 1000;

type InstallFlags = ReturnType<typeof parseInstallFlags>;

const parseInstallFlags = (args: string[]) =>
  parseCommandArgs(
    args,
    {
      ...runnerConnectionFlags.option,
      "no-self-update": { type: "boolean", default: false },
      ...runnerFlags.option,
    },
    usage,
  );

const unitArgsOf = (server: string, name: string, flags: InstallFlags, roots: string[]) => [
  "runner",
  "--server",
  server,
  "--unit",
  name,
  "--runs-in",
  flags["runs-in"],
  "--capacity",
  flags.capacity,
  ...flags.reach.flatMap((value) => ["--reach", value]),
  ...flags["trust-features"].flatMap((value) => ["--trust-features", value]),
  ...(flags["docker-in-container"] ? ["--docker-in-container"] : []),
  ...(flags.memory ? ["--memory", flags.memory] : []),
  ...(flags.cpus ? ["--cpus", flags.cpus] : []),
  ...roots.flatMap((root) => ["--root", root]),
  ...(flags.insecure ? ["--insecure"] : []),
  ...(flags["no-self-update"] ? ["--no-self-update"] : []),
];

const writeWrapper = async (home: string) => {
  const path = wrapperPath();
  const folder = dirname(path);
  const existing = await readTextFile(path);
  if (existing !== undefined && !isOwnWrapper(existing, home)) {
    console.warn(`${path} is not the command of this runner. The install did not change it.`);
    return;
  }
  await ensureFolder(folder);
  await replaceFile(path, wrapperTextOf({ home, nodePath: process.execPath }), 0o755);
  if (!(process.env.PATH ?? "").split(delimiter).includes(folder)) {
    console.warn(
      `Add ${folder} to PATH to run halinka of this runner, for example for halinka ssh.`,
    );
  }
};

// The log of the current start: systemd starts the runner again after a failure.
const waitForConnection = async (name: string) => {
  const deadline = Date.now() + connectTimeoutMs;
  return poll(async () => {
    const state = await readUnitState(name);
    const log = state.invocationId ? await readInvocationLog(state.invocationId) : "";
    if (state.activeState === "active" && log.includes(connectedMark)) {
      return { isConnected: true, log };
    }
    if (state.activeState === "failed" || state.activeState === "inactive") {
      fail(`The runner stopped with code ${state.exitStatus}:\n${log}`, state.exitStatus || 1);
    }
    if (Date.now() <= deadline) return undefined;
    // Some hosts keep no journal for the units of a user.
    return { isConnected: false, isLogMissing: state.activeState === "active" && !log, log };
  }, statePollMs);
};

type UnitFiles = Pick<RunnerUnit, "name" | "home" | "path" | "environment" | "args"> & {
  unitFile: string;
  sandboxKind: SandboxKind;
};

const writeUnit = async ({ unitFile, sandboxKind, ...unit }: UnitFiles) => {
  const { name, path, environment } = unit;
  if (
    sandboxKind === "devcontainer" &&
    !(await checkDockerInUserManager({ PATH: path, ...environment }))
  ) {
    console.warn(
      "Docker does not answer in the systemd of this user. If you added this user to the docker group, restart the user manager (it stops the other services of this user): systemctl restart user@$(id -u), or reboot.",
    );
  }
  await ensureFolder(userUnitFolder());
  await replaceFile(unitFile, unitTextOf({ ...unit, nodePath: process.execPath }));
  await systemctl("daemon-reload");
  if (!(await enableLinger())) {
    console.warn(
      `Without linger, the runner stops when you log out. Run: sudo loginctl enable-linger ${process.env.USER ?? "$USER"}`,
    );
  }
  await systemctl("enable", name);
};

const startUnit = async (name: string) => {
  // Failures before this install must not count toward the start limit.
  await systemctl("reset-failed", name).catch(() => {});
  await runUnitJob("restart", name);
};

export const runnerInstall = async (args: string[]) => {
  if (platform() !== "linux") {
    fail("halinka runner install needs Linux with systemd. Run halinka runner in a terminal.");
  }
  if (process.getuid?.() === 0) {
    fail("Run halinka runner install as the user that runs the runner, not as root.");
  }
  const flags = parseInstallFlags(args);
  const server = await parseServerFlag(flags.server, { isInsecure: flags.insecure, usage });
  const { sandboxKind } = parseRunnerFlags(flags, usage);
  const roots = await readFolderRoots(flags.root);
  await requireUserSystemd().catch(failWithError);
  const home = await readRunnerHome();
  const name = runnerUnitNameOf(home);
  const unitFile = unitFileOf(name);
  // fnm puts `node` only in a folder of its shell session, which the unit leaves out.
  const path = unitPathOf(`${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`);
  const environment = dockerEnvironmentOf(process.env);
  const unitArgs = unitArgsOf(server, name, flags, roots);
  const unitValues = [home, process.execPath, path, ...Object.values(environment), ...unitArgs];
  if (unitValues.some(hasControlCharacter)) {
    fail("A path, a variable or a flag holds a line break or another control character.");
  }
  // Before the stop: a failed download or npm install leaves the running unit as it is.
  const manifest =
    (await readServerPackage(server).catch(failWithError)) ?? fail(noPackageReason(server));
  console.log(`Installing halinka ${manifest.version} of ${server}`);
  const version = await installServerPackage(server, home, manifest).catch(failWithError);

  const hasUnit = await isFile(unitFile);
  // The running unit holds the lock of the home.
  if (hasUnit) await runUnitJob("stop", name).catch(failWithError);
  // Until the start: the enrollment, the switch and the unit write run as one step.
  const release = await takeRunnerLock(home, `install-${process.pid}`).catch(failWithError);
  // The installed build enrolls, as a later server can change the enrollment API.
  const enrolled = await runBuild(
    home,
    version,
    [
      "runner",
      "--server",
      server,
      ...(flags.insecure ? ["--insecure"] : []),
      "--enroll-only",
      ...(flags["enroll-stdin"] ? ["--enroll-stdin"] : []),
    ],
    { isForwardingStops: true },
  );
  if (enrolled !== 0) {
    await release();
    if (hasUnit) await runUnitJob("start", name).catch(() => {});
    process.exit(enrolled);
  }
  try {
    await switchCurrent(home, version);
    await clearUpdateFailures(home);
    await writeUnit({ name, home, unitFile, path, environment, args: unitArgs, sandboxKind });
  } catch (error) {
    await release();
    failWithError(error);
  }
  await release();
  await startUnit(name).catch(failWithError);
  await writeWrapper(home);

  const { isConnected, isLogMissing, log } = await waitForConnection(name);
  if (isLogMissing) {
    console.log(`The unit ${name} runs, but its log is not readable here: halinka runner status`);
    return;
  }
  if (!isConnected) {
    console.error(
      `${log}\nThe runner did not connect in ${connectTimeoutMs / 1000} s. Its unit stays installed: halinka runner status`,
    );
    process.exit(1);
  }
  console.log(
    `${log.trim()}\nThe runner runs as the systemd user unit ${name}: halinka runner status`,
  );
};
