import { type ChildProcess, spawn, type StdioOptions } from "node:child_process";
import type { Writable } from "node:stream";

import { execWithin } from "./process";
import { type ExecResult, sandboxCallTimeoutMs } from "./sandbox";

// Setup creates it; it has no sudo.
export const agentUser = "halinka-agent";

export const sysboxRuntime = "sysbox-runc";

// The CLI finds the devcontainer by this label, so nothing else can have it.
export const nameLabel = "halinka.sandbox";
export const networkLabel = "halinka.network";

const maxStderrChars = 64 * 1024;

export const shortCall = { timeoutMs: sandboxCallTimeoutMs };

type OutputOptions = {
  env?: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const spawnOutput = (command: string, args: string[], { env, input, signal }: OutputOptions) =>
  new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(command, args, { env, signal, stdio: "pipe" });
    // The command can exit before it reads its input.
    child.stdin.on("error", () => {}).end(input);
    const result = { stdout: "", stderr: "" };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (result.stdout += chunk));
    // The CLI writes its build logs to stderr.
    child.stderr
      .setEncoding("utf8")
      .on(
        "data",
        (chunk: string) => (result.stderr = (result.stderr + chunk).slice(-maxStderrChars)),
      );
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, ...result }));
  });

export const output = (command: string, args: string[], options: OutputOptions = {}) =>
  execWithin(
    [command, ...args],
    { signal: options.signal, timeoutMs: options.timeoutMs },
    ({ signal }) => spawnOutput(command, args, { ...options, signal }),
  );

export const docker = async (args: string[], options?: OutputOptions) => {
  const { exitCode, stdout, stderr } = await output("docker", args, options);
  if (exitCode !== 0) throw new Error(stderr.trim() || `docker ${args[0]} failed`);
  return stdout;
};

export const rootExec = (containerId: string, ...command: string[]) => [
  "exec",
  "--user",
  "root",
  containerId,
  ...command,
];

// `ps` shows `-e` values. Docker reads an env file by lines of at most 64 KiB.
export const splitEnvironment = (environment: Record<string, string>) => {
  const { file = [], args = [] } = Object.groupBy(Object.entries(environment), ([key, value]) =>
    /^\w+$/.test(key) && !/[\r\n]/.test(value) && Buffer.byteLength(`${key}=${value}`) < 65_000
      ? "file"
      : "args",
  );
  return {
    file: file.map(([key, value]) => `${key}=${value}\n`).join(""),
    args: args.flatMap(([key, value]) => ["-e", `${key}=${value}`]),
  };
};

// Linux cannot open a Node pipe (a socket) through /dev/fd, so the env file comes from a real pipe.
const execWithEnvFile = 'exec docker exec --env-file <(exec cat <&3) "$@" 3<&-';

// `args` follow `docker exec`; `stdio` gives fds 0 to 2.
export const spawnWithEnvFile = (
  args: string[],
  envFile: string,
  stdio: ["pipe" | "ignore", "pipe" | "ignore", "pipe" | "ignore"],
): ChildProcess => {
  const options: { stdio: StdioOptions } = { stdio: [...stdio, "pipe"] };
  const child = spawn("bash", ["-c", execWithEnvFile, "docker", ...args], options);
  const envPipe = child.stdio[3] as Writable;
  envPipe.on("error", () => {});
  envPipe.end(envFile);
  return child;
};

export const dockerLines = async (...args: string[]) =>
  (await docker(args, shortCall)).split("\n").filter(Boolean);
