import type { ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { StepPermissions } from "@halinka/workflow";

const separators = new Set([";", "&", "|", "(", ")", "`", "\n"]);
const escapedInDoubleQuotes = new Set(['"', "\\", "$", "`", "\n"]);

// The words of each simple command, with the quotes and the backslashes of a POSIX shell.
const commandsOf = (text: string) => {
  const commands: string[][] = [[]];
  let word: string | undefined;
  const endWord = () => {
    if (word !== undefined) commands.at(-1)!.push(word);
    word = undefined;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      const stop = end === -1 ? text.length : end;
      word = (word ?? "") + text.slice(index + 1, stop);
      index = stop;
    } else if (char === '"') {
      word ??= "";
      for (index++; index < text.length && text[index] !== '"'; index++) {
        if (text[index] === "\\" && escapedInDoubleQuotes.has(text[index + 1] ?? "")) index++;
        word += text[index];
      }
    } else if (char === "\\") {
      word = (word ?? "") + (text[index + 1] ?? "");
      index++;
    } else if (char === " " || char === "\t") {
      endWord();
    } else if (separators.has(char)) {
      endWord();
      commands.push([]);
    } else {
      word = (word ?? "") + char;
    }
  }
  endWord();
  return commands;
};

type GitArgs = { options: string[]; names: string[] };

// `valueOptions` take the next word as their value, so it is not a name.
const gitArgsOf = (args: string[], valueOptions: string[]): GitArgs => {
  const options: string[] = [];
  const names: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      names.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      names.push(arg);
      continue;
    }
    const [option = arg] = arg.split("=");
    options.push(option);
    if (!arg.includes("=") && valueOptions.includes(option)) index++;
  }
  return { options, names };
};

const rule =
  (changes: (args: GitArgs) => boolean, valueOptions: string[] = []) =>
  (args: string[]) =>
    changes(gitArgsOf(args, valueOptions));

// `git branch`, `git tag` and `git replace` list refs with one of these options or with no name.
const listOptions = [
  "-l",
  "--list",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
];

const changesNamedRef = ({ options, names }: GitArgs) =>
  names.length > 0 &&
  !options.some((option) => listOptions.includes(option) || /^-n\d*$/.test(option));

const actionNotIn =
  (reads: string[], fallback: string) =>
  ({ names }: GitArgs) =>
    !reads.includes(names[0] ?? fallback);

// The runner owns the history, the refs and the remotes.
const gitWrites = new Map<string, (args: string[]) => boolean>([
  ...[
    "commit",
    "reset",
    "rebase",
    "checkout",
    "switch",
    "push",
    "pull",
    "fetch",
    "merge",
    "cherry-pick",
    "revert",
    "am",
    "remote",
    "update-ref",
    "fast-import",
    "filter-branch",
    "filter-repo",
    "config",
    "bisect",
    "gc",
    "prune",
  ].map((subcommand) => [subcommand, () => true] as const),
  ["branch", rule(changesNamedRef, ["--format", "--sort", "-u", "--set-upstream-to"])],
  [
    "tag",
    rule(changesNamedRef, [
      "--format",
      "--sort",
      "-m",
      "--message",
      "-F",
      "--file",
      "-u",
      "--local-user",
      "--cleanup",
      "--trailer",
    ]),
  ],
  ["replace", rule(changesNamedRef, ["--format"])],
  ["notes", rule(actionNotIn(["list", "show"], "list"), ["--ref"])],
  ["stash", rule(actionNotIn(["list", "show"], "push"))],
  ["worktree", rule(actionNotIn(["list"], "list"))],
  ["reflog", rule(({ names }) => names[0] === "expire" || names[0] === "delete")],
  [
    "symbolic-ref",
    rule(
      ({ options, names }) =>
        names.length > 1 || options.includes("-d") || options.includes("--delete"),
      ["-m"],
    ),
  ],
]);

const gitValueOptions = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"];

const isGitWrite = (words: string[]) => {
  let index = 0;
  for (; words[index]?.startsWith("-"); index++) {
    const word = words[index]!;
    const [option, ...value] = word.split("=");
    const isValueNext = !word.includes("=") && gitValueOptions.includes(word);
    const config = isValueNext ? words[index + 1] : value.join("=");
    // An alias can run any other command.
    if ((option === "-c" || option === "--config-env") && /^alias\./i.test(config ?? "")) {
      return true;
    }
    if (isValueNext) index++;
  }
  const [subcommand, ...args] = words.slice(index);
  return subcommand !== undefined && (gitWrites.get(subcommand)?.(args) ?? false);
};

const shells = ["sh", "bash", "zsh", "dash", "ksh"];

const nameOf = (word: string) => word.slice(word.lastIndexOf("/") + 1);

const changesGit = (words: string[]): boolean =>
  words.some((word, index) => {
    if ((word.includes("$(") || word.includes("`")) && changesGitIn(word)) return true;
    const name = nameOf(word);
    if (name === "git") return isGitWrite(words.slice(index + 1));
    if (!shells.includes(name)) return false;
    const script = words.findIndex((flag, at) => at > index && /^-\w*c/.test(flag)) + 1;
    return script > 0 && script < words.length && changesGitIn(words[script]!);
  });

const changesGitIn = (text: string) => commandsOf(text).some(changesGit);

const writeKinds = new Set(["edit", "delete", "move"]);

const inputOf = ({ rawInput }: ToolCallUpdate) =>
  rawInput !== null && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};

const changesGitBy = (toolCall: ToolCallUpdate) => {
  const { command } = inputOf(toolCall);
  if (typeof command === "string") return changesGitIn(command);
  if (Array.isArray(command)) return changesGit(command.map(String));
  return changesGitIn(toolCall.title ?? "");
};

const hostOf = (toolCall: ToolCallUpdate) => {
  const { url } = inputOf(toolCall);
  return typeof url === "string" ? URL.parse(url)?.hostname : undefined;
};

// Defense in depth: the sandbox is the boundary.
export const checkPermission = (toolCall: ToolCallUpdate, permissions: StepPermissions) => {
  const { kind } = toolCall;
  if (writeKinds.has(kind ?? "") && !permissions.write) return "The step is read-only";
  if (kind === "execute") {
    if (!permissions.shell) return "The step cannot run commands";
    if (changesGitBy(toolCall)) {
      return "Halinka makes the commits; git commands that change the history, the refs or the remotes are refused";
    }
  }
  if (kind === "fetch" && permissions.network !== true) {
    const host = hostOf(toolCall);
    if (!host || !permissions.network.includes(host)) return "The step cannot reach this host";
  }
  return undefined;
};
