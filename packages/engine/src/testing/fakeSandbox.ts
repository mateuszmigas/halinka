import type { ExecOptions, ExecResult, Sandbox, WorkspaceOwner } from "@halinka/sandbox";
import { abortError } from "@halinka/utils/errors";

const subcommandOf = (command: string[]) => command[command.lastIndexOf("-c") + 2];

export class FakeSandbox implements Sandbox {
  readonly workspaceFolder = "/code/app";
  readonly ran: string[] = [];
  readonly owners: WorkspaceOwner[] = [];
  // the give-backs and the session closes, in order
  readonly workspaceLog: string[] = [];
  readonly writtenAs: WorkspaceOwner[] = [];
  readonly committedAs: WorkspaceOwner[] = [];
  readonly gitNetworks: unknown[] = [];
  readonly scriptNetworks: [string, unknown][] = [];
  private readonly hangs = Promise.withResolvers<void>();
  private owner: WorkspaceOwner = "host";
  private refusedOwner: WorkspaceOwner | undefined;
  private commits = 0;
  private failingGit: string | undefined;
  private agentChanges = ["src/app.ts"];
  private changedFiles: string[] = [];

  get hanging() {
    return this.hangs.promise;
  }

  refuseOwner(refused: WorkspaceOwner) {
    this.refusedOwner = refused;
  }

  failGit(subcommand: string) {
    this.failingGit = subcommand;
  }

  setAgentChanges(files: string[]) {
    this.agentChanges = files;
  }

  setChangesBefore(files: string[]) {
    this.changedFiles = files;
  }

  agentWrites() {
    this.writtenAs.push(this.owner);
    this.writeAgentChanges();
  }

  async assignWorkspace(assigned: WorkspaceOwner) {
    if (assigned === this.refusedOwner) throw new Error("chown: Operation not permitted");
    this.owner = assigned;
    this.owners.push(assigned);
    this.workspaceLog.push(assigned);
  }

  async spawn(): Promise<never> {
    throw new Error("The fake sandbox does not start processes");
  }

  async exec(command: string[], { signal, onOutput, network }: ExecOptions = {}) {
    if (command[0] === "git") {
      this.gitNetworks.push(network);
      if (subcommandOf(command) === "commit-tree") this.committedAs.push(this.owner);
      return this.git(command);
    }
    const script = command[2] ?? "";
    this.ran.push(script);
    this.scriptNetworks.push([script, network]);
    const isFirstRun = this.ran.filter((ranScript) => ranScript === script).length === 1;
    if (script === "missing") throw new Error("spawn sh ENOENT");
    if (script === "generate" || script === "fail after generate") this.writeAgentChanges();
    if (script === "stop changes") {
      this.setAgentChanges([]);
      return { exitCode: 1, stdout: "tests failed\n", stderr: "" };
    }
    if (script === "stop changes, fail once") {
      this.setAgentChanges([]);
      return { exitCode: isFirstRun ? 1 : 0, stdout: "tests failed\n", stderr: "" };
    }
    if (script === "fail once") {
      onOutput?.("tests failed\n", "stdout");
      return { exitCode: isFirstRun ? 1 : 0, stdout: "tests failed\n", stderr: "" };
    }
    if (script === "mixed") {
      for (const [text, stream] of [
        ["out 1\n", "stdout"],
        ["err 1\n", "stderr"],
        ["out", "stdout"],
        [" 2\n", "stdout"],
      ] as const) {
        onOutput?.(text, stream);
      }
      return { exitCode: 0, stdout: "out 1\nout 2\n", stderr: "err 1\n" };
    }
    if (script === "split a lent value") {
      onOutput?.("token sk-lent", "stdout");
      onOutput?.("-value-1 done\n", "stdout");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (script === "crash in a lent value") {
      onOutput?.("token sk-lent", "stdout");
      throw new Error("The container stopped");
    }
    if (script === "flood") {
      for (let index = 0; index < 10; index++) onOutput?.("x".repeat(64 * 1024), "stdout");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (script === "hang") {
      this.hangs.resolve();
      await new Promise((_, reject) =>
        signal?.addEventListener("abort", () => reject(abortError())),
      );
    }
    onOutput?.(`${script}\n`, "stdout");
    return { exitCode: script.startsWith("fail") ? 1 : 0, stdout: `${script}\n`, stderr: "" };
  }

  private writeAgentChanges() {
    this.changedFiles = [...new Set([...this.changedFiles, ...this.agentChanges])];
  }

  private git(command: string[]): ExecResult {
    const subcommand = subcommandOf(command);
    if (subcommand === this.failingGit) {
      return { exitCode: 128, stdout: "", stderr: `fatal: ${subcommand} failed` };
    }
    if (subcommand === "commit-tree") {
      this.commits++;
      this.changedFiles = [];
      return { exitCode: 0, stdout: `sha-${this.commits}\n`, stderr: "" };
    }
    if (subcommand === "diff" && command.includes("--name-only")) {
      const stdout = this.changedFiles.map((file) => `${file}\0`).join("");
      return { exitCode: 0, stdout, stderr: "" };
    }
    if (subcommand === "status") {
      const stdout = this.changedFiles.map((file) => ` M ${file}\0`).join("");
      return { exitCode: 0, stdout, stderr: "" };
    }
    if (subcommand === "reset" && command.includes("--hard")) this.changedFiles = [];
    const stdout = subcommand === "rev-parse" ? `sha-${this.commits}\n` : "";
    return { exitCode: 0, stdout, stderr: "" };
  }
}
