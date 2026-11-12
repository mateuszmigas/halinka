import { homedir } from "node:os";
import { join } from "node:path";

import { hashOf } from "@halinka/utils/hash";

import { currentMainOf } from "./runnerVersions";

const dockerVariables = [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION",
];

// Folders of one shell session: fnm and npx delete them later.
const sessionFolderPattern = /\/fnm_multishells\/|\/_npx\//;

const wrapperMark = "# Written by halinka runner install";

// The graceful stop waits for the runs to end and their containers to stop.
const stopTimeoutSeconds = 300;

export type RunnerUnit = {
  name: string;
  home: string;
  nodePath: string;
  path: string;
  environment: Record<string, string>;
  args: string[];
};

export const runnerUnitNameOf = (home: string) => `halinka-runner-${hashOf(home).slice(0, 12)}`;

export const wrapperPath = () => join(homedir(), ".local", "bin", "halinka");

export const unitPathOf = (path: string) =>
  [
    ...new Set(path.split(":").filter((folder) => folder && !sessionFolderPattern.test(folder))),
  ].join(":");

export const dockerEnvironmentOf = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(
    dockerVariables.flatMap((name) => (env[name] ? [[name, env[name]] as const] : [])),
  );

// A line break would end the setting or the comment of the wrapper and start a new one.
export const hasControlCharacter = (value: string) =>
  Array.from({ length: value.length }, (_, index) => value.charCodeAt(index)).some(
    (code) => code < 0x20 || code === 0x7f,
  );

const systemdEscapes: Record<string, string> = { "\\": "\\\\", '"': '\\"', "%": "%%", $: "$$" };

// `Environment=` takes `$` as it is; only a command line expands it.
const quotedForSystemd = (value: string, specials: RegExp) =>
  `"${value.replace(specials, (char) => systemdEscapes[char] ?? char)}"`;

const commandArgument = (value: string) => quotedForSystemd(value, /[\\"%$]/g);

// systemd does not expand `$` in the path of the program.
const commandProgram = (value: string) => quotedForSystemd(value, /[\\"%]/g);

const environmentValue = (value: string) => quotedForSystemd(value, /[\\"%]/g);

export const unitTextOf = ({ name, home, nodePath, path, environment, args }: RunnerUnit) => {
  const command = [
    commandProgram(nodePath),
    ...[currentMainOf(home), ...args].map(commandArgument),
  ].join(" ");
  const variables = { HALINKA_HOME: home, PATH: path, ...environment };
  return [
    "[Unit]",
    `Description=Halinka runner of ${home.replace(/%/g, "%%")}`,
    "StartLimitIntervalSec=600",
    "StartLimitBurst=5",
    "",
    "[Service]",
    `ExecStart=${command}`,
    ...Object.entries(variables).map(
      ([key, value]) => `Environment=${environmentValue(`${key}=${value}`)}`,
    ),
    "Restart=always",
    "RestartSec=10",
    "RestartPreventExitStatus=78",
    "KillMode=mixed",
    `TimeoutStopSec=${stopTimeoutSeconds}`,
    `SyslogIdentifier=${name}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
};

const quotedForShell = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

// A login shell of ssh has no nvm `PATH`, so the script names `node` itself.
export const wrapperTextOf = ({ home, nodePath }: Pick<RunnerUnit, "home" | "nodePath">) =>
  [
    "#!/bin/sh",
    `${wrapperMark} for ${home}`,
    `export HALINKA_HOME=${quotedForShell(home)}`,
    `exec ${quotedForShell(nodePath)} ${quotedForShell(currentMainOf(home))} "$@"`,
    "",
  ].join("\n");

export const isOwnWrapper = (text: string, home: string) =>
  text.split("\n")[1] === `${wrapperMark} for ${home}`;
