import type { ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { StepPermissions } from "@halinka/workflow";
import { describe, expect, it } from "vitest";

import { checkPermission } from "./permissionPolicy";

const all: StepPermissions = { write: true, shell: true, network: true };

const call = (fields: Partial<ToolCallUpdate>): ToolCallUpdate => ({ toolCallId: "1", ...fields });

const execute = (command: string) => call({ kind: "execute", rawInput: { command } });

describe("checkPermission", () => {
  it("refuses an edit of a read-only step", () => {
    expect(checkPermission(call({ kind: "edit" }), { ...all, write: false })).toBe(
      "The step is read-only",
    );
  });

  it("refuses a command of a step without shell", () => {
    expect(checkPermission(execute("ls"), { ...all, shell: false })).toBe(
      "The step cannot run commands",
    );
  });

  it.each([
    "git commit -m fix",
    "cd app && git push origin main",
    "git -C app reset --hard HEAD~1",
    "git --no-pager rebase main",
    "npm test; git checkout -b other",
    "/usr/bin/git commit -m fix",
    "git branch -f main HEAD~1",
    "git branch --delete old",
    "git config core.hooksPath /tmp",
    "git branch feature",
    "git branch -D old",
    "git branch -m old new",
    "git tag v1",
    "git tag -a v1 -m Release",
    "git tag -d v1",
    "git tag -f v1 HEAD~1",
    "git status && git tag v1",
    "git stash",
    "git stash pop",
    "git notes add -m note",
    "git worktree add ../other",
    "git symbolic-ref HEAD refs/heads/other",
    "git replace HEAD HEAD~1",
    "git bisect start",
    "git -c alias.x='tag x' x",
    "git --config-env=alias.x=ALIAS x",
    'git -C "folder name" tag v1',
    "sh -c 'git tag x'",
    'bash -lc "git branch feature"',
    "/bin/zsh -c 'cd app && git tag x'",
    'echo "$(git tag v1)"',
    "git tag -a v1 -m 'release --list notes'",
    "git t\\ag v1",
    "git gc --prune=now",
    "git gc",
    "git prune",
    "git reflog expire --expire=now --all",
    "git reflog delete HEAD@{1}",
    "git fast-export main | git fast-import --force",
  ])("refuses the git command %s", (command) => {
    expect(checkPermission(execute(command), all)).toContain("git commands");
  });

  it.each([
    "git status",
    "git diff main...HEAD",
    "git log --oneline",
    "git show HEAD:package.json",
    "git branch --list",
    "git branch",
    "git branch -a",
    "git branch -vv",
    "git branch --show-current",
    "git branch --list 'feature/*'",
    "git branch --contains HEAD",
    "git tag",
    "git tag -l 'v*'",
    "git tag -n",
    "git tag --points-at HEAD",
    "git tag --sort=-creatordate | head -1",
    "git stash list",
    "git worktree list",
    "git symbolic-ref --short HEAD",
    "echo $(git branch --show-current)",
    "git commit-tree HEAD^{tree}",
    "git branch --format '%(refname)'",
    "git tag --sort version:refname",
    "git notes --ref foo show",
    "git reflog",
    "git -c color.ui=never log",
    'grep -r "git tag" docs',
    "sh -c 'git status'",
  ])("allows %s", (command) => {
    expect(checkPermission(execute(command), all)).toBeUndefined();
  });

  it("allows a fetch of any host with network true", () => {
    const fetch = call({ kind: "fetch", rawInput: { url: "https://any.example" } });

    expect(checkPermission(fetch, all)).toBeUndefined();
  });

  it("refuses a git command named only in the title", () => {
    expect(checkPermission(call({ kind: "execute", title: "git push --force" }), all)).toContain(
      "git commands",
    );
  });

  it("refuses a git command given as a list of words", () => {
    const listed = call({
      kind: "execute",
      rawInput: { command: ["git", "-C", "folder name", "tag", "v1"] },
    });

    expect(checkPermission(listed, all)).toContain("git commands");
  });

  it("refuses a git command given as a list", () => {
    const listed = call({ kind: "execute", rawInput: { command: ["git", "push"] } });

    expect(checkPermission(listed, all)).toContain("git commands");
  });

  it("allows a fetch of a host in the list", () => {
    const fetch = call({ kind: "fetch", rawInput: { url: "https://docs.example.com/a" } });

    expect(checkPermission(fetch, { ...all, network: ["docs.example.com"] })).toBeUndefined();
  });

  it("refuses a fetch of a host outside the list", () => {
    const fetch = call({ kind: "fetch", rawInput: { url: "https://evil.example" } });

    expect(checkPermission(fetch, { ...all, network: ["docs.example.com"] })).toBe(
      "The step cannot reach this host",
    );
  });

  it("refuses a search, which names no host, without network true", () => {
    const search = call({ kind: "fetch", rawInput: { query: "x" } });

    expect(checkPermission(search, { ...all, network: ["docs.example.com"] })).toBe(
      "The step cannot reach this host",
    );
  });
});
