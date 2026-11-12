import { describe, expect, it } from "vitest";

import {
  dockerEnvironmentOf,
  hasControlCharacter,
  isOwnWrapper,
  type RunnerUnit,
  runnerUnitNameOf,
  unitPathOf,
  unitTextOf,
  wrapperTextOf,
} from "./runnerUnit";

const unit: RunnerUnit = {
  name: "halinka-runner-abc",
  home: "/home/ada/.halinka",
  nodePath: "/home/ada/.local/node/bin/node",
  path: "/usr/bin:/bin",
  environment: {},
  args: ["runner", "--server", "https://halinka.example.com"],
};

const lineOf = (text: string, prefix: string) =>
  text.split("\n").find((line) => line.startsWith(prefix));

describe("runnerUnit", () => {
  it("starts the current version of the home with absolute paths", () => {
    expect(lineOf(unitTextOf(unit), "ExecStart=")).toBe(
      'ExecStart="/home/ada/.local/node/bin/node" "/home/ada/.halinka/versions/current/node_modules/halinka/dist/main.js" "runner" "--server" "https://halinka.example.com"',
    );
  });

  it("escapes quotes, percent signs and dollar signs for systemd", () => {
    const text = unitTextOf({ ...unit, args: ['a"b', "50%", "$HOME", "c\\d"] });

    expect(lineOf(text, "ExecStart=")).toContain('"a\\"b" "50%%" "$$HOME" "c\\\\d"');
  });

  it("keeps a dollar sign in the path of the program", () => {
    const text = unitTextOf({ ...unit, nodePath: "/opt/$node/bin/node" });

    expect(lineOf(text, "ExecStart=")).toMatch(/^ExecStart="\/opt\/\$node\/bin\/node" /);
  });

  it("keeps a dollar sign of a variable as it is", () => {
    const text = unitTextOf({ ...unit, home: "/srv/$runner" });

    expect(lineOf(text, 'Environment="HALINKA_HOME')).toBe(
      'Environment="HALINKA_HOME=/srv/$runner"',
    );
  });

  it("finds a line break in a value of the unit", () => {
    expect([hasControlCharacter("/srv/a\nb"), hasControlCharacter("/srv/a b")]).toEqual([
      true,
      false,
    ]);
  });

  it("starts the runner again after each exit but 78, also after a clean one", () => {
    const text = unitTextOf(unit);

    expect([lineOf(text, "Restart="), lineOf(text, "RestartPreventExitStatus=")]).toEqual([
      "Restart=always",
      "RestartPreventExitStatus=78",
    ]);
  });

  it("gives the unit the home, the path and the Docker variables", () => {
    const text = unitTextOf({ ...unit, environment: { DOCKER_HOST: "unix:///run/docker.sock" } });

    expect(text.split("\n").filter((line) => line.startsWith("Environment="))).toEqual([
      'Environment="HALINKA_HOME=/home/ada/.halinka"',
      'Environment="PATH=/usr/bin:/bin"',
      'Environment="DOCKER_HOST=unix:///run/docker.sock"',
    ]);
  });

  it("keeps no folder of a shell session in the path", () => {
    const path =
      "/run/user/1000/fnm_multishells/42_1/bin:/home/ada/.npm/_npx/9a/node_modules/.bin:/usr/bin";

    expect(unitPathOf(path)).toBe("/usr/bin");
  });

  it("keeps only the Docker variables that the shell sets", () => {
    expect(dockerEnvironmentOf({ DOCKER_CONTEXT: "rootless", HOME: "/home/ada" })).toEqual({
      DOCKER_CONTEXT: "rootless",
    });
  });

  it("gives each home its own unit name", () => {
    expect(runnerUnitNameOf("/home/ada/.halinka")).not.toBe(runnerUnitNameOf("/srv/halinka"));
  });

  it("knows its own wrapper by the home", () => {
    const text = wrapperTextOf(unit);

    expect([isOwnWrapper(text, unit.home), isOwnWrapper(text, "/srv/halinka")]).toEqual([
      true,
      false,
    ]);
  });

  it("quotes the home in the wrapper for the shell", () => {
    const text = wrapperTextOf({ ...unit, home: "/home/o'neil/.halinka" });

    expect(text).toContain("export HALINKA_HOME='/home/o'\\''neil/.halinka'");
  });
});
