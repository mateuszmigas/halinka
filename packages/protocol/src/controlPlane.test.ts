import { describe, expect, it } from "vitest";

import { isSshHostKey, limitChangedFiles, pushedBranchWriteSchema } from "./controlPlane";

const names = (count: number, length = 8) =>
  Array.from({ length: count }, (_, index) => String(index).padStart(length, "0"));

describe("controlPlane", () => {
  it("gives all names, sorted, when they are in the limits", () => {
    expect(limitChangedFiles(["b.ts", "a.ts"])).toEqual({
      changedFiles: ["a.ts", "b.ts"],
      changedFileCount: 2,
    });
  });

  it("gives the first 1000 names and the count of all", () => {
    const files = names(1001);

    expect(limitChangedFiles(files)).toEqual({
      changedFiles: files.slice(0, 1000),
      changedFileCount: 1001,
    });
  });

  it("gives the first names of at most 64 Ki characters together", () => {
    const files = names(100, 1024);

    expect(limitChangedFiles(files).changedFiles).toEqual(files.slice(0, 64));
  });

  it("gives the count that the caller gives", () => {
    expect(limitChangedFiles(["a.ts"], 5).changedFileCount).toBe(5);
  });

  it("takes one Ed25519 key", () => {
    expect(isSshHostKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5+/==")).toBe(true);
  });

  it.each([
    ["a second line", "ssh-ed25519 AAAA\n* ssh-ed25519 BBBB"],
    ["a line end", "ssh-ed25519 AAAA\n"],
    ["a host pattern", "* ssh-ed25519 AAAA"],
    ["another key type", "ssh-rsa AAAA"],
    ["a comment", "ssh-ed25519 AAAA comment"],
  ])("refuses %s", (_name, key) => {
    expect(isSshHostKey(key)).toBe(false);
  });

  const expected = "a".repeat(40);

  it("takes a commit id and the URL of a pull request", () => {
    const write = { expected, pullRequestUrl: "https://github.com/acme/app/pull/1" };

    expect(pushedBranchWriteSchema.safeParse(write).success).toBe(true);
  });

  it.each([
    ["an expected value that is no commit id", { expected: "" }],
    ["a URL on another host", { expected, pullRequestUrl: "https://github.test/acme/app/pull/1" }],
    ["a URL that is no pull request", { expected, pullRequestUrl: "https://github.com/acme/app" }],
  ])("refuses %s", (_name, write) => {
    expect(pushedBranchWriteSchema.safeParse(write).success).toBe(false);
  });
});
