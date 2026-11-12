import { type Checkpoint, maxCheckpointChangedFilesLength } from "@halinka/protocol";
import { type Sandbox, sandboxGitTimeoutMs } from "@halinka/sandbox";
import { Git, halinkaIdentity } from "@halinka/utils/git";

const maxChangedFiles = 10_000;
const maxStagedDiffChars = 64 * 1024 * 1024;

export type LentValues = {
  // the engine records a masked result, as the server stores it, so a recovered run decides the same
  mask: <T>(value: T) => T;
  find: (text: string) => string | undefined;
  heldLength: (text: string) => number;
};

export const unchangedCheckpoint = (before: string): Checkpoint => ({
  before,
  after: before,
  changedFiles: [],
});

export type CheckpointAttempt = { stepId: string; attempt: number; summary?: string };

export type CheckpointsOptions = {
  sandbox: Sandbox;
  lent: LentValues;
  workflowRunId: number;
  branch: string;
  signal: AbortSignal;
};

export class Checkpoints {
  private readonly git: Git;
  private readonly lent: LentValues;
  private readonly workflowRunId: number;
  private readonly branch: string;

  constructor({ sandbox, lent, workflowRunId, branch, signal }: CheckpointsOptions) {
    this.lent = lent;
    this.workflowRunId = workflowRunId;
    this.branch = branch;
    this.git = new Git(sandbox, halinkaIdentity, {
      timeoutMs: sandboxGitTimeoutMs,
      signal,
      workTree: sandbox.workspaceFolder,
    });
  }

  async readHead() {
    const head = await this.git.findBranch(this.branch);
    if (!head) throw new Error(`The branch ${this.branch} is missing`);
    return head;
  }

  // The agent can commit or change branch: put HEAD back and fold its commits into one.
  async commit(before: string, attempt: CheckpointAttempt): Promise<Checkpoint> {
    await this.git.restoreBranch(this.branch, before);
    const committed = await this.commitWorkspace(
      before,
      `${attempt.stepId}: attempt ${attempt.attempt}`,
      attempt,
    );
    if (!committed) return unchangedCheckpoint(before);
    return { before, ...committed };
  }

  // Undefined when nothing changed.
  async commitChangesBefore(head: string, stepId: string, attempt: number) {
    // The agent can stage a gitlink, which `add` keeps.
    await this.git.restoreBranch(this.branch, head);
    const title = `${stepId}: changes before attempt ${attempt}`;
    return (await this.commitWorkspace(head, title, { stepId, attempt }))?.after;
  }

  async discard(before: string) {
    const { git } = this;
    await git.restoreBranch(this.branch, before);
    const changed = await git.listChanges();
    if (changed.length > 0) await git.discardChanges();
    return changed;
  }

  private async commitWorkspace(parent: string, title: string, attempt: CheckpointAttempt) {
    const { git } = this;
    await git.addAll();
    const changedFiles = await git.listStagedFiles(maxCheckpointChangedFilesLength);
    if (changedFiles.length === 0) return undefined;
    if (changedFiles.length > maxChangedFiles) {
      throw new Error(
        `The attempt changed ${changedFiles.length} files. A checkpoint can hold at most ${maxChangedFiles} files.`,
      );
    }
    this.requireNoLentValues(await git.listStagedAddedLines(maxStagedDiffChars), changedFiles);
    const after = await git.commitIndex(parent, this.message(title, attempt));
    return { after, changedFiles };
  }

  // The diff of a new empty file has no line with its path.
  private requireNoLentValues(addedLines: string[], changedFiles: string[]) {
    const refuse = (file: string | undefined, name: string) => {
      throw new Error(
        `The changes in ${this.lent.mask(file)} contain the value of ${name}. Halinka does not commit a lent credential.`,
      );
    };
    for (const file of changedFiles) {
      const name = this.lent.find(file);
      if (name) refuse(file, name);
    }
    for (const [index, lines] of addedLines.entries()) {
      const name = this.lent.find(lines);
      if (name) refuse(changedFiles[index], name);
    }
  }

  private message(title: string, { stepId, attempt, summary }: CheckpointAttempt) {
    const trailers = [
      `Halinka-Run: ${this.workflowRunId}`,
      `Halinka-Step: ${stepId}`,
      `Halinka-Attempt: ${attempt}`,
    ];
    const body = summary && this.lent.mask(summary.trim());
    return [title, body, trailers.join("\n")].filter(Boolean).join("\n\n");
  }
}
