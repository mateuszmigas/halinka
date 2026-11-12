import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { commitAll } from "@halinka/runner/testing";
import { hostGit } from "@halinka/sandbox/host";
import { pathExists } from "@halinka/utils/fs";
import { writeFiles } from "@halinka/utils/testing";
import { expect } from "@playwright/test";

export class TestRepo {
  constructor(readonly path: string) {}

  get name() {
    return basename(this.path);
  }

  static async create(path: string, files: Record<string, string>) {
    await writeFiles(path, { "README.md": "# Test repo\n", ...files });
    await hostGit(path).run("init", "--quiet", "--initial-branch=main");
    await commitAll(path, "Initial commit");
    return new TestRepo(path);
  }

  async writeFile(path: string, content: string) {
    await writeFiles(this.path, { [path]: content });
    return this;
  }

  async expectFile(path: string, content?: string) {
    const actual = await readFile(join(this.path, path), "utf8");
    if (content !== undefined) expect(actual).toBe(content);
    return this;
  }

  async expectCommittedFile(branch: string, path: string, content: string) {
    const show = () =>
      hostGit(this.path)
        .run("show", `${branch}:${path}`)
        .catch(() => undefined);
    await expect.poll(show).toBe(content.trimEnd());
    return this;
  }

  async expectNoFile(path: string) {
    expect(await pathExists(join(this.path, path))).toBe(false);
    return this;
  }
}
