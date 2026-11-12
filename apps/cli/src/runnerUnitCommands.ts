import { rm } from "node:fs/promises";

import { isFile, readTextFile } from "@halinka/utils/fs";

import { fail, failWithError, parseCommandArgs } from "./args";
import { isOwnWrapper, runnerUnitNameOf, wrapperPath } from "./runnerUnit";
import { readCurrentVersion, readRunnerHome } from "./runnerVersions";
import {
  readUnitState,
  requireUserSystemd,
  runUnitJob,
  showUnitStatus,
  systemctl,
  unitFileOf,
} from "./userSystemd";

const statusUsage = `Usage: halinka runner status

Shows the systemd unit of the runner of this machine and its last log lines.`;

const uninstallUsage = `Usage: halinka runner uninstall

Stops the systemd unit of the runner of this machine and deletes it. Keeps runner.json and the installed
versions, so halinka runner install can install it again. The runner stays registered on the server.`;

const findInstalledUnit = async () => {
  await requireUserSystemd().catch(failWithError);
  const home = await readRunnerHome();
  const name = runnerUnitNameOf(home);
  const unitFile = unitFileOf(name);
  if (!(await isFile(unitFile))) {
    fail(`The runner of ${home} has no systemd unit. Install it with halinka runner install.`);
  }
  return { home, name, unitFile };
};

export const runnerStatus = async (args: string[]) => {
  parseCommandArgs(args, {}, statusUsage);
  const { home, name } = await findInstalledUnit();
  const current = (await readCurrentVersion(home)) ?? "none";
  console.log(`Runner of ${home}, unit ${name}, version ${current}`);
  const [, { activeState }] = await Promise.all([showUnitStatus(name), readUnitState(name)]);
  if (activeState === "failed") {
    console.log(
      `To start it again after you repair the cause: systemctl --user reset-failed ${name} && systemctl --user start ${name}`,
    );
  }
};

export const runnerUninstall = async (args: string[]) => {
  parseCommandArgs(args, {}, uninstallUsage);
  const { home, name, unitFile } = await findInstalledUnit();
  await runUnitJob("disable", "--now", name).catch(failWithError);
  await rm(unitFile);
  await systemctl("daemon-reload").catch(failWithError);
  await systemctl("reset-failed", name).catch(() => {});
  const wrapperText = await readTextFile(wrapperPath());
  if (wrapperText !== undefined && isOwnWrapper(wrapperText, home)) await rm(wrapperPath());
  console.log(
    `Deleted the unit ${name}. ${home} keeps runner.json and the installed versions. The runner stays registered: revoke it in the portal to end its key.`,
  );
};
