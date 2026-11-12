import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const systemctlTimeoutMs = 60_000;
// Longer than `TimeoutStopSec` of the unit, which a stop can use up.
const unitJobTimeoutMs = 6 * 60 * 1000;

export const userUnitFolder = () =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user");

export const unitFileOf = (name: string) => join(userUnitFolder(), `${name}.service`);

export const systemctl = async (...args: string[]) =>
  (await run("systemctl", ["--user", ...args], { timeout: systemctlTimeoutMs })).stdout.trim();

// A stop, a restart or a `disable --now`: each waits for the graceful stop of the runner.
export const runUnitJob = async (...args: string[]) => {
  await run("systemctl", ["--user", ...args], { timeout: unitJobTimeoutMs });
};

export const requireUserSystemd = () =>
  systemctl("show-environment").catch(() => {
    throw new Error(
      "systemd of this user does not answer. Log in as this user (not with su or sudo), on a Linux host with systemd.",
    );
  });

// `false` when it needs another permission, for example of polkit.
export const enableLinger = () =>
  run("loginctl", ["enable-linger"], { timeout: systemctlTimeoutMs }).then(
    () => true,
    () => false,
  );

type UnitState = { activeState: string; exitStatus: number; invocationId: string };

export const readUnitState = async (name: string): Promise<UnitState> => {
  const text = await systemctl("show", name, "-p", "ActiveState,ExecMainStatus,InvocationID");
  const values = Object.fromEntries(text.split("\n").map((line) => line.split("=", 2)));
  return {
    activeState: values.ActiveState ?? "",
    exitStatus: Number(values.ExecMainStatus ?? 0),
    invocationId: values.InvocationID ?? "",
  };
};

export const showUnitStatus = async (name: string) => {
  const child = spawn("systemctl", ["--user", "status", name, "--no-pager", "--lines=20"], {
    stdio: "inherit",
  });
  await once(child, "exit");
};

// Empty where the user has no journal, for example on WSL.
export const readInvocationLog = (invocationId: string) =>
  run(
    "journalctl",
    ["--user", `_SYSTEMD_INVOCATION_ID=${invocationId}`, "-o", "cat", "--no-pager"],
    {
      timeout: systemctlTimeoutMs,
    },
  ).then(
    ({ stdout }) => stdout,
    () => "",
  );

// The user manager keeps the groups of its start: a new `docker` group needs its restart.
export const checkDockerInUserManager = (environment: Record<string, string>) =>
  run(
    "systemd-run",
    [
      "--user",
      "--wait",
      "--pipe",
      "--quiet",
      "--collect",
      ...Object.entries(environment).map(([key, value]) => `--setenv=${key}=${value}`),
      "docker",
      "info",
    ],
    { timeout: systemctlTimeoutMs },
  ).then(
    () => true,
    () => false,
  );
