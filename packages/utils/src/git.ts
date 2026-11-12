import { errorMessage, isAbortError } from "./errors";

const commitPattern = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

// A value from a sandbox can be anything, also an option of git.
export const isCommitId = (value: string) => commitPattern.test(value);

export const shortSha = (sha: string) => sha.slice(0, 7);

export type CommandResult = { exitCode: number; stdout: string; stderr: string };

export type ExecCall = {
  timeoutMs?: number;
  maxOutputChars?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
};

// `workTree`: git uses `<workTree>/.git` and never looks for another repository.
export type GitOptions = ExecCall & { workTree?: string };

export type Executor = {
  exec: (command: string[], call: ExecCall) => Promise<CommandResult>;
};

// The `.gitattributes` of a commit can select a filter of the host config.
export const noHostConfig = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "0",
  GIT_CONFIG_PARAMETERS: "",
};

export const halinkaIdentity = { "user.name": "Halinka", "user.email": "halinka@localhost" };

// Checks belong in gates, and an agent or a nested repository can name a command for git to run.
const defaultConfig = {
  "core.hooksPath": "/dev/null",
  "commit.gpgsign": "false",
  "log.showSignature": "false",
  "core.fsmonitor": "false",
  // The credential scan pairs diffs with paths, so two names must not give one header.
  "core.quotePath": "true",
  "submodule.recurse": "false",
  "diff.submodule": "short",
};

const failure = ([subcommand]: string[], { exitCode, stdout, stderr }: CommandResult) =>
  new Error(`git ${subcommand} failed with exit code ${exitCode}: ${(stderr || stdout).trim()}`);

// `add`, `status` and `reset --hard` refresh the index; git 2.36 added `--no-refresh`.
const canSkipIndexRefresh = (version: string) => {
  const [, major = "0", minor = "0"] = /(\d+)\.(\d+)/.exec(version) ?? [];
  return Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 36);
};

// `exec` gives UTF-8 text, so git cannot find a path of another name.
const requireUtf8Path = (path: string, kind: string) => {
  if (path.includes("\uFFFD")) throw new Error(`The ${kind} ${path} has a name that is not UTF-8`);
  return path;
};

// A patch line starts with a space, `+`, `-` or a git header, never with this.
const commitMarker = "halinka-commit ";

const addedLinesArgs = ["--text", "--no-color", "--no-renames", "--no-ext-diff", "--no-textconv"];

const addedLinesOf = (output: string) => {
  const fileDiffs: string[] = [];
  let previousHeader: string | undefined;
  // Not a regex: `^` also matches after `\r`, which a binary file can hold.
  for (const fileDiff of `\n${output}`.split("\ndiff --git ").slice(1)) {
    const header = fileDiff.slice(0, fileDiff.indexOf("\n"));
    // A change of the file type gives two diffs of one path.
    if (header === previousHeader) fileDiffs[fileDiffs.length - 1] += `\n${fileDiff}`;
    else fileDiffs.push(fileDiff);
    previousHeader = header;
  }
  return fileDiffs.map((fileDiff) =>
    fileDiff
      .split("\n")
      .filter((line) => line.startsWith("+"))
      .join("\n"),
  );
};

// Through the environment, so `ps` does not show `hiddenConfig`.
const remoteEnv = (hiddenConfig: Record<string, string>) => {
  const entries = Object.entries({ ...hiddenConfig, "core.askPass": "" });
  return Object.fromEntries([
    ["GIT_TERMINAL_PROMPT", "0"],
    ["GIT_CONFIG_COUNT", String(entries.length)],
    ...entries.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  ]) as Record<string, string>;
};

type CommitChangesOptions = { maxCount: number; maxOutputChars: number };

// `expected` undefined: the branch must not exist there.
type PushCommitOptions = {
  branch: string;
  expected: string | undefined;
  hiddenConfig: Record<string, string>;
};

export class Git {
  private readonly globalArgs: string[];
  private readonly call: ExecCall;
  private resetOptions?: string[];

  constructor(
    private readonly executor: Executor,
    config: Record<string, string> = {},
    { workTree, ...call }: GitOptions = {},
  ) {
    const configArgs = Object.entries({ ...defaultConfig, ...config }).flatMap(([key, value]) => [
      "-c",
      `${key}=${value}`,
    ]);
    // Git searches a parent folder for a repository when `.git` is not valid.
    const repoArgs = workTree ? [`--git-dir=${workTree}/.git`, `--work-tree=${workTree}`] : [];
    this.globalArgs = [...repoArgs, ...configArgs];
    this.call = call;
  }

  async run(...args: string[]) {
    return (await this.output(args)).trim();
  }

  async isBare() {
    return (await this.run("rev-parse", "--is-bare-repository")) === "true";
  }

  async findRoot() {
    const result = await this.exec(["rev-parse", "--show-toplevel"]);
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  findCommit(rev: string) {
    return this.find("rev-parse", "--verify", "--quiet", `${rev}^{commit}`);
  }

  findBranch(branch: string) {
    return this.findCommit(`refs/heads/${branch}`);
  }

  async listWorktrees() {
    const output = await this.run("worktree", "list", "--porcelain", "-z");
    return output
      .split("\0\0")
      .filter(Boolean)
      .map((entry) => {
        const [first = "", ...fields] = entry.split("\0");
        const branch = fields.find((field) => field.startsWith("branch "));
        return {
          path: first.slice("worktree ".length),
          branch: branch?.slice("branch refs/heads/".length),
          isPrunable: fields.some((field) => field.startsWith("prunable")),
        };
      });
  }

  // One entry for each path of `listStagedFiles`, in its order; `--text` includes binary files.
  async listStagedAddedLines(maxOutputChars: number) {
    const args = ["diff", "--cached", ...addedLinesArgs];
    return addedLinesOf(await this.output(args, { maxOutputChars }));
  }

  // Oldest first. `changes`: the file headers and the added lines of the commit's patch.
  async listCommitChanges(
    from: string,
    to: string,
    { maxCount, maxOutputChars }: CommitChangesOptions,
  ) {
    const range = [`--max-count=${maxCount}`, `${from}..${to}`];
    const patchArgs = ["log", "--reverse", "-p", "--diff-merges=first-parent", ...addedLinesArgs];
    const [messages, patches] = await Promise.all([
      this.output(["log", "--reverse", "--format=%x00%H%n%B", ...range], { maxOutputChars }),
      this.output([...patchArgs, `--format=${commitMarker}%H`, ...range], { maxOutputChars }),
    ]);
    const changes = new Map<string, string[]>();
    let current: string[] = [];
    for (const line of patches.split("\n")) {
      if (line.startsWith(commitMarker)) {
        current = [];
        changes.set(line.slice(commitMarker.length), current);
      } else if (line.startsWith("+") || line.startsWith("diff --git ")) {
        current.push(line);
      }
    }
    return messages
      .split("\0")
      .slice(1)
      .map((entry) => {
        const commit = entry.slice(0, entry.indexOf("\n"));
        const message = entry.slice(commit.length + 1);
        const added = changes.get(commit);
        if (!added) throw new Error(`git log gave no patch of the commit ${commit}`);
        return { commit, message, changes: added.join("\n") };
      });
  }

  findRemoteUrl(remote: string) {
    return this.find("config", "--get", `remote.${remote}.url`);
  }

  // The prefixes that `url.*.insteadOf` and `url.*.pushInsteadOf` rewrite.
  async listUrlRewrites() {
    const result = await this.exec(["config", "--get-regexp", "^url\\..*\\.(push)?insteadof$"]);
    if (result.exitCode === 1) return [];
    if (result.exitCode !== 0) throw failure(["config"], result);
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(line.indexOf(" ") + 1));
  }

  async findRemoteBranch(url: string, branch: string, hiddenConfig: Record<string, string>) {
    const ref = `refs/heads/${branch}`;
    const output = await this.output(["ls-remote", url, ref], { env: remoteEnv(hiddenConfig) });
    // The pattern of `ls-remote` also finds a ref that only ends with `ref`.
    const line = output.split("\n").find((entry) => entry.endsWith(`\t${ref}`));
    return line ? line.slice(0, line.indexOf("\t")) : undefined;
  }

  // To the URL, not to a remote, so no remote config adds a destination.
  async pushCommit(
    url: string,
    commit: string,
    { branch, expected, hiddenConfig }: PushCommitOptions,
  ) {
    const ref = `refs/heads/${branch}`;
    const env = remoteEnv(hiddenConfig);
    const lease = `--force-with-lease=${ref}:${expected ?? ""}`;
    const scope = ["--no-follow-tags", "--recurse-submodules=no"];
    const args = ["push", "--quiet", "--no-verify", ...scope, lease, url, `${commit}:${ref}`];
    await this.output(args, { env });
  }

  // A rename gives both paths.
  async listStagedFiles(maxOutputChars: number) {
    const args = ["diff", "--cached", "--name-only", "--no-renames", "-z"];
    const output = await this.output(args, { maxOutputChars });
    return output.split("\0").filter(Boolean);
  }

  // A mixed reset keeps the files of the worktree.
  async restoreBranch(branch: string, commit: string) {
    await this.run("symbolic-ref", "HEAD", `refs/heads/${branch}`);
    this.resetOptions ??= canSkipIndexRefresh(await this.run("version")) ? ["--no-refresh"] : [];
    await this.run("reset", "--quiet", ...this.resetOptions, commit);
    await this.clearIndexFlags();
  }

  // `commit` reads the worktree again, which takes seconds on a bind mount.
  async commitIndex(parent: string, message: string) {
    const tree = await this.run("write-tree");
    const commit = await this.run("commit-tree", "-p", parent, "-m", message, tree);
    await this.run("update-ref", "HEAD", commit, parent);
    return commit;
  }

  // An existing ref keeps its commit.
  async createRef(ref: string, commit: string) {
    if (!(await this.findCommit(ref))) await this.run("update-ref", ref, commit);
  }

  // The empty old value makes git refuse a branch that exists.
  async createBranch(branch: string, commit: string) {
    await this.run("update-ref", `refs/heads/${branch}`, commit, "");
  }

  // git refuses the move when the branch is not at `expected`.
  async moveBranch(branch: string, commit: string, expected: string) {
    await this.run("update-ref", `refs/heads/${branch}`, commit, expected);
  }

  async fetchCommit(source: string, commit: string, hiddenConfig?: Record<string, string>) {
    const args = [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-auto-maintenance",
      "--recurse-submodules=no",
      "--end-of-options",
      source,
      commit,
    ];
    await this.output(args, hiddenConfig && { env: remoteEnv(hiddenConfig) });
  }

  // `git bundle` needs a ref, and `exec` gives text, not bytes.
  async prepareBundle(commit: string, exclude: string) {
    await this.run("update-ref", "refs/halinka/bundle", commit);
    return [
      "git",
      ...this.globalArgs,
      "bundle",
      "create",
      "-",
      "refs/halinka/bundle",
      `^${exclude}`,
    ];
  }

  // `--no-hardlinks`: a hard-linked object file of the source is writable through the clone.
  async cloneBranch(source: string, folder: string, branch: string) {
    await this.run(
      "clone",
      "--quiet",
      "--template=",
      "--local",
      "--no-hardlinks",
      "--no-checkout",
      "--single-branch",
      "--branch",
      branch,
      source,
      folder,
    );
  }

  async deleteRemote(name: string) {
    await this.run("remote", "remove", name);
  }

  async findRegularFile(commit: string, path: string) {
    const output = await this.output(["ls-tree", "-z", "--long", commit, "--", path]);
    const [entry] = output.split("\0").filter(Boolean);
    if (!entry) return undefined;
    const [info = "", entryPath] = entry.split("\t");
    const [mode, type, blob, size] = info.split(/ +/);
    if (entryPath !== path || type !== "blob" || mode === "120000" || !blob) return undefined;
    return { blob, size: Number(size) };
  }

  // `.gitattributes` of the commit can leave files out (`export-ignore`).
  async archive(commit: string, file: string) {
    // A tree has no signature for `export-subst` to verify.
    await this.run("archive", "--format=tar", "--output", file, `${commit}^{tree}`);
  }

  // Do not trim: keep the file as it is.
  readBlob(blob: string) {
    return this.output(["cat-file", "blob", blob]);
  }

  // `.git` at the repository top; with `workTree`: its absolute path, or the target of a `.git` file.
  findGitFolder() {
    return this.find("rev-parse", "--git-dir");
  }

  // The absolute git folder of the worktree, and the folder that all worktrees of the repository share.
  async findGitFolders() {
    const folders = await this.run(
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
    );
    const [gitFolder = "", commonFolder = ""] = folders.split("\n");
    return { gitFolder, commonFolder };
  }

  // One line for each commit of `from..to`, with the values of its `key` trailers.
  async listTrailers(from: string, to: string, key: string) {
    const output = await this.output([
      "log",
      `--format=%(trailers:key=${key},valueonly,separator=%x2C)`,
      "--end-of-options",
      `${from}..${to}`,
    ]);
    return output.split("\n").slice(0, -1);
  }

  async deleteRefs(prefix: string) {
    const refs = await this.run("for-each-ref", "--format=%(refname)", prefix);
    for (const ref of refs.split("\n").filter(Boolean)) await this.run("update-ref", "-d", ref);
  }

  async deleteBranch(branch: string, expected: string) {
    await this.run("update-ref", "-d", `refs/heads/${branch}`, expected);
  }

  async isHeldOutsideBranch(commit: string, branch: string) {
    const refs = await this.run(
      "for-each-ref",
      "--format=%(refname)",
      "--contains",
      commit,
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    );
    return refs.split("\n").some((ref) => ref && ref !== `refs/heads/${branch}`);
  }

  isAncestor(ancestor: string, commit: string) {
    return this.test("merge-base", "--is-ancestor", ancestor, commit);
  }

  async readMergeBase(first: string, second: string) {
    return (await this.run("merge-base", first, second)).trim();
  }

  // Git in a nested repository runs its filter drivers; only the flag has priority over `.gitmodules`.
  async listChanges() {
    const output = await this.output([
      "status",
      "--porcelain",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=all",
    ]);
    const entries = output.split("\0").filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      paths.push(entry.slice(3));
      // A staged rename or copy has its source path in the next entry.
      if (entry[0] === "R" || entry[0] === "C") index++;
    }
    return paths;
  }

  // A gitlink of HEAD keeps its commit; git in a nested repository runs its filter drivers.
  async addAll() {
    const gitlinks = await this.listGitlinks();
    const excluded = gitlinks.map((path) => `:(top,exclude,literal)${path}`);
    await this.run("add", "--all", "--", ":/", ...excluded);
  }

  // Ignored files stay. The second `--force` also removes a nested repository.
  async discardChanges() {
    await this.run("reset", "--hard", "--quiet");
    await this.run("clean", "-d", "--force", "--force", "--quiet");
  }

  async addWorktree(folder: string, branch: string) {
    await this.run("worktree", "add", "--quiet", folder, branch);
  }

  async addWorktreeWithNewBranch(folder: string, branch: string, startPoint: string) {
    await this.run("worktree", "add", "--quiet", "-b", branch, folder, startPoint);
  }

  // `--force` also removes changed and untracked files.
  async deleteWorktree(folder: string) {
    await this.run("worktree", "remove", "--force", folder);
  }

  async pruneWorktrees() {
    await this.run("worktree", "prune");
  }

  // A reset keeps these flags, and a flagged file hides its changes from git.
  private async clearIndexFlags() {
    const entries = (await this.output(["ls-files", "-v", "-z"])).split("\0");
    const pathsOf = (pattern: RegExp) =>
      entries.filter((entry) => pattern.test(entry)).map((entry) => entry.slice(2));
    const assumed = pathsOf(/^[a-z] /);
    const skipped = pathsOf(/^[Ss] /);
    await this.updateIndex("--no-assume-unchanged", assumed);
    // A sparse checkout sets skip-worktree on the files outside its patterns.
    if (
      skipped.length > 0 &&
      (await this.find("config", "--bool", "core.sparseCheckout")) !== "true"
    )
      await this.updateIndex("--no-skip-worktree", skipped);
  }

  // `exec` has no stdin, and the arguments of one command have a size limit.
  private async updateIndex(option: string, paths: string[]) {
    for (const path of paths) requireUtf8Path(path, "flagged path");
    for (let start = 0; start < paths.length; start += 1000) {
      await this.run("update-index", option, "--", ...paths.slice(start, start + 1000));
    }
  }

  // The agent can write the index, so the gitlinks come from HEAD.
  private async listGitlinks() {
    const output = await this.output(["ls-tree", "-r", "-z", "HEAD"]);
    return output
      .split("\0")
      .filter((entry) => entry.startsWith("160000 "))
      .map((entry) => requireUtf8Path(entry.slice(entry.indexOf("\t") + 1), "gitlink"));
  }

  private async output(args: string[], call?: ExecCall) {
    const result = await this.exec(args, call);
    if (result.exitCode !== 0) throw failure(args, result);
    return result.stdout;
  }

  // An abort stays an AbortError: the engine reads it as a stop.
  private async exec(args: string[], call?: ExecCall) {
    try {
      const env = this.call.env || call?.env ? { ...this.call.env, ...call?.env } : undefined;
      return await this.executor.exec(["git", ...this.globalArgs, ...args], {
        ...this.call,
        ...call,
        env,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new Error(`git ${args[0]} failed: ${errorMessage(error)}`, { cause: error });
    }
  }

  // git exits 1 for "no" or "not found"
  private async find(...args: string[]) {
    const result = await this.exec(args);
    if (result.exitCode > 1) throw failure(args, result);
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  private async test(...args: string[]) {
    return (await this.find(...args)) !== undefined;
  }
}
