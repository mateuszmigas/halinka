export type OutputStream = "stdout" | "stderr";

// `agent`: a user without sudo, whose processes all stop with the command.
export type SandboxUser = "remote" | "agent";

// `host`: the host user, which removes the workspace; a devcontainer also restores the git config.
export type WorkspaceOwner = "agent" | "host";

// The host sandbox ignores `network`, `credentialNames`, `user` and `isRepoCode`.
export type SpawnOptions = {
  env?: Record<string, string>;
  // No hosts by default, all hosts for `true`.
  network?: true | string[];
  credentialNames?: string[];
  user?: SandboxUser;
  // a shell step, a gate or `setup.run`: it can use Docker inside the container
  isRepoCode?: boolean;
  signal: AbortSignal;
};

export const sandboxCallTimeoutMs = 30_000;
export const sandboxGitTimeoutMs = 5 * 60_000;

export const maxStderrTailChars = 4096;

// The `code` of the error of `exec` at `maxOutputChars`.
export const outputLimitCode = "output_limit";

export type ExecOptions = Partial<SpawnOptions> & {
  onOutput?: (chunk: string, stream: OutputStream) => void;
  // At a limit, `exec` stops the command and rejects with an Error, not an AbortError.
  timeoutMs?: number;
  // stdout and stderr together, in characters
  maxOutputChars?: number;
  // false: the result has no stdout and only the last `maxStderrTailChars` characters of stderr
  isOutputKept?: boolean;
};

// A missing command exits with 127 in a container and rejects on the host.
export type ExecResult = { exitCode: number; stdout: string; stderr: string };

// Read stdout and stderr to the end: a full pipe pauses the process.
export type SandboxProcess = {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  // the processes that the command started ended too
  stopped: Promise<void>;
};

// When the command exits, the sandbox stops the processes that it leaves and soon ends its output.
export type Sandbox = {
  workspaceFolder: string;
  // It returns after the output ends, and rejects when the sandbox does not run.
  exec: (command: string[], options?: ExecOptions) => Promise<ExecResult>;
  spawn: (command: string[], options: SpawnOptions) => Promise<SandboxProcess>;
  // "host" stops each process of the agent first, or refuses while one can hold a git lock.
  assignWorkspace: (owner: WorkspaceOwner) => Promise<void>;
};
