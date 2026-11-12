import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it, vi } from "vitest";

import { ghLogin, parseGitHubRemote } from "./github";

const fakeGh = async (script?: string) => {
  const folder = await tempFolder();
  if (script)
    await writeFile(
      join(folder, "gh"),
      `#!/bin/sh
${script}
`,
      { mode: 0o755 },
    );
  vi.stubEnv("PATH", folder);
};

const loginToken = () => ghLogin.token(new AbortController().signal);

describe("github", () => {
  it("gives the token of the login on github.com", async () => {
    await fakeGh(`[ "$*" = "auth token --hostname github.com" ] && echo gho-login-1`);

    expect(await loginToken()).toBe("gho-login-1");
  });

  it("tells the reason when the user has no login", async () => {
    await fakeGh(`echo "not logged in" >&2; exit 1`);

    await expect(loginToken()).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("no GitHub login (not logged in)"),
    });
  });

  it("refuses a gh login when the host has no gh program", async () => {
    await fakeGh();

    await expect(loginToken()).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("ENOENT"),
    });
  });

  it.each([
    "https://github.com/acme/app.git",
    "https://github.com/acme/app",
    "https://github.com/acme/app/",
    "git@github.com:acme/app.git",
    "ssh://git@github.com/acme/app.git",
  ])("reads the GitHub repo of the remote %s", (url) => {
    expect(parseGitHubRemote(url)).toEqual({ owner: "acme", name: "app" });
  });

  it.each([
    "https://gitlab.com/acme/app.git",
    "https://user:token@github.com/acme/app.git",
    "https://github.com.evil.test/acme/app.git",
    "https://github.com/acme/app/extra",
    "/srv/git/app.git",
  ])("refuses the remote %s", (url) => {
    expect(parseGitHubRemote(url)).toBeUndefined();
  });
});
