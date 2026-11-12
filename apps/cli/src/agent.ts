import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import type { ParseArgsOptionsConfig } from "node:util";

import { isCancel, password } from "@clack/prompts";
import {
  codexLoginLocks,
  parseCodexAuth,
  saveCodexLogin,
  withCodexLoginLock,
} from "@halinka/runner/codexLogin";
import {
  type ApiClient,
  type ApiError,
  type ApiOutputs,
  createApiClient,
} from "@halinka/server/client";
import { errnoCode, errorMessage } from "@halinka/utils/errors";
import { readTextFile } from "@halinka/utils/fs";
import { halinkaHome } from "@halinka/utils/halinkaHome";
import { poll } from "@halinka/utils/poll";

import { formatApiFailure } from "./apiFailure";
import { fail, failWithUsage, parseCommandWithPositionals } from "./args";
import { readToken } from "./logins";
import { safeText } from "./safeText";
import { resolveServer } from "./serverChoice";
import { forwardStopSignals } from "./signals";

type Agent = ApiOutputs["agents"]["list"][number];

type Flags<T extends ParseArgsOptionsConfig> = ReturnType<
  typeof parseCommandWithPositionals<T>
>["values"];

type Subcommand = { synopsis: string; run: (args: string[]) => Promise<void> };

type CodexLoginOptions = { isDeviceAuth: boolean };

type SetEnabledOptions = { isEnabled: boolean };

const codexMissing =
  "Halinka needs Codex on this machine. Install it: npm install --global @openai/codex";

const stateLabels: Record<Agent["credentials"][number]["state"], string> = {
  set: "set",
  not_set: "not set",
  unreadable: "set with another master key: enter it again",
};

const testPollMs = 2000;

const serverOption = { server: { type: "string" } } as const;

const mineOption = { mine: { type: "boolean", default: false } } as const;

const flagSynopsis = (options: ParseArgsOptionsConfig) =>
  Object.entries(options).map(([name, { type }]) => {
    if (name === "server") return "[options]";
    return type === "boolean" ? `[--${name}]` : `--${name} <${name}>`;
  });

const subcommand = <T extends ParseArgsOptionsConfig>(spec: {
  arguments: string[];
  options: T;
  run: (positionals: string[], flags: Flags<T>) => Promise<void>;
}): Subcommand => ({
  synopsis: [...spec.arguments, ...flagSynopsis(spec.options)].join(" "),
  run: async (args) => {
    const { values, positionals } = parseCommandWithPositionals(args, spec.options, usage);
    if (positionals.length !== spec.arguments.length) {
      return failWithUsage("Give the action and its arguments.", usage);
    }
    await spec.run(positionals, values);
  },
});

const withApi = async (flag: string | undefined, call: (api: ApiClient) => Promise<unknown>) => {
  const server = await resolveServer(flag, { usage, sends: "a token or a key", fallback: "local" });
  await call(createApiClient(server, { token: await readToken(server) })).catch((error: ApiError) =>
    fail(safeText(formatApiFailure(error, server))),
  );
};

const waitForExit = (child: ChildProcess) =>
  new Promise<number | null>((resolve, reject) => {
    child.on("error", (error) =>
      reject(errnoCode(error) === "ENOENT" ? new Error(codexMissing) : error),
    );
    child.on("exit", resolve);
  });

// A temporary CODEX_HOME gives Halinka its own refresh chain.
const loginWithCodex = async ({ isDeviceAuth }: CodexLoginOptions) => {
  const codexHome = await mkdtemp(join(tmpdir(), "halinka-codex-"));
  let endForward = () => {};
  try {
    const args = [
      "login",
      "-c",
      'cli_auth_credentials_store="file"',
      ...(isDeviceAuth ? ["--device-auth"] : []),
    ];
    const child = spawn("codex", args, {
      stdio: "inherit",
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    // It ends after the removal, so a signal cannot leave the tokens on disk.
    endForward = forwardStopSignals(child);
    if ((await waitForExit(child)) !== 0) throw new Error("The Codex login did not complete.");
    const auth = await readTextFile(join(codexHome, "auth.json"));
    if (auth === undefined) throw new Error("Codex wrote no auth.json.");
    return parseCodexAuth(auth);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
    endForward();
  }
};

const saveLoginOfCodex = async (options: CodexLoginOptions) => {
  const home = halinkaHome();
  const onWait = (pid: number) =>
    console.log(`Waiting for the process ${pid}, which holds the Codex login.`);
  const path = await loginWithCodex(options)
    .then((login) =>
      withCodexLoginLock(codexLoginLocks(home), () => saveCodexLogin(home, login), { onWait }),
    )
    .catch((error: unknown) => fail(errorMessage(error)));
  console.log(`Saved the ChatGPT login in ${path}.`);
};

const readKey = async (variable: string) => {
  if (!process.stdin.isTTY) return text(process.stdin);
  const value = await password({ message: `Value of ${variable}` });
  return isCancel(value) ? fail("No value was given.") : value;
};

const printKeysAndTests = (
  { credentials, tests }: Pick<Agent, "credentials" | "tests">,
  keyLabel: string,
  testLabel: string,
) => {
  for (const { variable, state } of credentials) {
    console.log(`  ${keyLabel}${variable}: ${stateLabels[state]}`);
  }
  for (const { runner, status, isOutdated } of tests) {
    console.log(`  ${testLabel} ${safeText(runner)}: ${status}${isOutdated ? ", old" : ""}`);
  }
};

const printAgent = (agent: Agent) => {
  const { preset, isEnabled, version, defaultVersion, model, mine } = agent;
  const modelText = model ? `  ${model}` : "";
  console.log(
    `${preset}  ${isEnabled ? "enabled" : "disabled"}  ${version ?? defaultVersion}${modelText}`,
  );
  printKeysAndTests(agent, "", "test on");
  if (mine) printKeysAndTests(mine, "your ", "test of your key on");
};

type TestAgentOptions = { preset: string; runner: string; isMine: boolean };

// Ctrl+C leaves the test: the runner finishes it.
const testAgent = async (api: ApiClient, { preset, runner, isMine }: TestAgentOptions) => {
  await (isMine ? api.agents.testMine : api.agents.test)({ preset, runner });
  console.log(`Testing ${preset} on ${safeText(runner)}. The first test can take some minutes.`);
  const test = await poll(async () => {
    const agent = (await api.agents.list()).find((item) => item.preset === preset);
    const tests = isMine ? agent?.mine?.tests : agent?.tests;
    const found = tests?.find((item) => item.runner === runner);
    return found?.status === "passed" || found?.status === "failed" ? found : undefined;
  }, testPollMs);
  if (test.status === "failed") return fail(safeText(`The test failed: ${test.error}`));
  const names = Object.keys(test.capabilities ?? {}).join(", ");
  console.log(safeText(`The test passed. Capabilities: ${names || "none"}.`));
};

const setEnabled = ({ isEnabled }: SetEnabledOptions) =>
  subcommand({
    arguments: ["<agent>"],
    options: serverOption,
    run: ([preset = ""], flags) =>
      withApi(flags.server, async (api) => {
        await api.agents.update({ preset, isEnabled });
        console.log(`${preset} is ${isEnabled ? "enabled" : "disabled"}.`);
      }),
  });

const subcommands: Record<string, Subcommand> = {
  login: subcommand({
    arguments: ["codex"],
    options: { "device-auth": { type: "boolean", default: false } },
    run: ([name], flags) =>
      name === "codex"
        ? saveLoginOfCodex({ isDeviceAuth: flags["device-auth"] })
        : failWithUsage("Give the action and its arguments.", usage),
  }),
  list: subcommand({
    arguments: [],
    options: serverOption,
    run: (_, flags) =>
      withApi(flags.server, async (api) => (await api.agents.list()).forEach(printAgent)),
  }),
  enable: setEnabled({ isEnabled: true }),
  disable: setEnabled({ isEnabled: false }),
  version: subcommand({
    arguments: ["<agent>", "<version>|default"],
    options: serverOption,
    run: ([preset = "", value], flags) =>
      withApi(flags.server, async (api) => {
        const version = value === "default" ? null : value;
        await api.agents.update({ preset, version });
        console.log(`${preset} uses ${version ?? "the version of its preset"}.`);
      }),
  }),
  model: subcommand({
    arguments: ["<agent>", "<model>|default"],
    options: serverOption,
    run: ([preset = "", value], flags) =>
      withApi(flags.server, async (api) => {
        const model = value === "default" ? null : value;
        await api.agents.update({ preset, model });
        console.log(`${preset} uses ${model ?? "its own default model"}.`);
      }),
  }),
  key: subcommand({
    arguments: ["<agent>", "<variable>"],
    options: { remove: { type: "boolean", default: false }, ...mineOption, ...serverOption },
    run: ([preset = "", variable = ""], flags) =>
      withApi(flags.server, async (api) => {
        if (flags.remove) {
          const input = { preset, variable };
          await (flags.mine ? api.agents.deleteMyCredential : api.agents.deleteCredential)(input);
          console.log(`Removed the stored ${variable} of ${preset}.`);
          return;
        }
        const input = { preset, variable, value: await readKey(variable) };
        await (flags.mine ? api.agents.setMyCredential : api.agents.setCredential)(input);
        console.log(`Stored ${variable} of ${preset}.`);
      }),
  }),
  test: subcommand({
    arguments: ["<agent>"],
    options: { runner: { type: "string" }, ...mineOption, ...serverOption },
    run: ([preset = ""], { runner, mine, server }) =>
      runner
        ? withApi(server, (api) => testAgent(api, { preset, runner, isMine: mine }))
        : failWithUsage("Give the runner with --runner.", usage),
  }),
};

const usage = `Usage:
${Object.entries(subcommands)
  .map(([name, { synopsis }]) => `  halinka agent ${name} ${synopsis}`.trimEnd())
  .join("\n")}

"login" logs in to ChatGPT with the codex command of this machine, and saves the login for the
runners on this machine. The login is apart from your own Codex login.
"key" reads the value from stdin, or asks for it in a terminal. Only a run in a devcontainer gets it.
"test" asks the agent for a one-word reply on the runner, which costs a small amount.

Options:
  --device-auth   Log in with a code at chatgpt.com, for a machine without a browser
  --mine          Your own key, which your runs use in place of the key of the team
  --server <url>  The server (default: HALINKA_SERVER_URL, then the server of halinka use, then
                  the server that runs on this machine)`;

export const agent = async (args: string[]) => {
  const [name = "", ...rest] = args;
  if (Object.hasOwn(subcommands, name)) return subcommands[name]!.run(rest);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    return;
  }
  return failWithUsage("Give the action and its arguments.", usage);
};
