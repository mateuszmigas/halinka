import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { hostGit } from "@halinka/sandbox/host";
import { tempFolder } from "@halinka/utils/testing";
import { describe, expect, it, vi } from "vitest";

import { GitHubMirrors } from "./githubMirrors";
import { commitFile, createRepo, gitHttpServer } from "./testing";

const access = { owner: "acme", name: "app", token: "ghs-read-token-1" };
const header = `Basic ${Buffer.from(`x-access-token:${access.token}`).toString("base64")}`;

// "GitHub" serves the commits of `source` at `/acme/app.git`.
const setUp = async (authorization = header) => {
  const gitHubFolder = await tempFolder();
  const source = await createRepo();
  const commit = await hostGit(source).run("rev-parse", "HEAD");
  await mkdir(join(gitHubFolder, "acme"));
  const bare = join(gitHubFolder, "acme/app.git");
  await hostGit(gitHubFolder).run("clone", "--quiet", "--bare", source, bare);
  const server = await gitHttpServer(gitHubFolder, authorization);
  const root = await tempFolder();
  const mirrors = new GitHubMirrors(join(root, "github"), server.url);
  const readAccess = vi.fn(async () => access);
  const fetchInto = (...commits: string[]) =>
    mirrors.ensureCommits({
      githubRepoId: 100,
      commits: commits.length > 0 ? commits : [commit],
      groupsFile: join(root, "groups"),
      readAccess,
      signal: new AbortController().signal,
    });
  return { root, source, bare, commit, server, mirrors, readAccess, fetchInto };
};

describe("GitHubMirrors", () => {
  it("fetches the commit into a bare clone", async () => {
    const { fetchInto, commit } = await setUp();

    const path = await fetchInto();

    expect(await hostGit(path).findCommit(commit)).toBe(commit);
    expect(await hostGit(path).isBare()).toBe(true);
  });

  it("fetches the two commits of a run", async () => {
    const { fetchInto, commit, source, bare } = await setUp();
    await commitFile(source, "head");
    const head = await hostGit(source).run("rev-parse", "HEAD");
    await hostGit(source).run("push", "--quiet", bare, "HEAD:refs/heads/fix");

    const path = await fetchInto(commit, head);

    expect(await hostGit(path).findCommit(commit)).toBe(commit);
    expect(await hostGit(path).findCommit(head)).toBe(head);
  });

  it("gives GitHub only the token header", async () => {
    const { fetchInto, server } = await setUp();

    await fetchInto();

    expect(new Set(server.headers)).toEqual(new Set([header]));
  });

  it("creates one clone for two runs that start at the same time", async () => {
    const { fetchInto, commit } = await setUp();

    const paths = await Promise.all([fetchInto(), fetchInto()]);

    expect(paths[0]).toBe(paths[1]);
    expect(await hostGit(paths[0]).findCommit(commit)).toBe(commit);
  });

  it("asks for no token when the clone has the commit", async () => {
    const { fetchInto, readAccess } = await setUp();

    await fetchInto();
    await fetchInto();

    expect(readAccess).toHaveBeenCalledTimes(1);
  });

  it("fetches a later commit into the same clone", async () => {
    const { fetchInto, source, bare, readAccess } = await setUp();
    const path = await fetchInto();
    const later = await commitFile(source, "later.txt");
    await hostGit(bare).run("fetch", "--quiet", source, "HEAD:refs/heads/later");

    expect(await fetchInto(later)).toBe(path);

    expect(await hostGit(path).findCommit(later)).toBe(later);
    expect(readAccess).toHaveBeenCalledTimes(2);
  });

  it("keeps the token out of the clone", async () => {
    const { fetchInto } = await setUp();

    const path = await fetchInto();

    expect(await hostGit(path).run("config", "--list", "--local")).not.toContain(access.token);
  });

  it("masks the token in the error of the fetch", async () => {
    const { fetchInto, readAccess } = await setUp("Basic another-token");
    // git names the URL in its error.
    readAccess.mockResolvedValue({ ...access, name: access.token });

    const failure = await fetchInto().catch((error: Error) => error);

    expect(failure).toMatchObject({ code: "conflict" });
    expect((failure as Error).message).toContain("Git could not fetch");
    expect((failure as Error).message).not.toContain(access.token);
  });

  it("refuses a config that rewrites the URL of GitHub", async () => {
    const { fetchInto, mirrors, source, server } = await setUp();
    await fetchInto();
    const path = mirrors.pathOf(100);
    await hostGit(path).run("config", `url.https://other.example/.insteadOf`, server.url);
    const later = await commitFile(source, "later.txt");

    await expect(fetchInto(later)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("rewrites"),
    });
  });

  it("refuses an id that is not a number, because it becomes a path", async () => {
    const mirrors = new GitHubMirrors("/unused");

    expect(() => mirrors.pathOf("../../other" as unknown as number)).toThrow("not a number");
  });

  it("refuses a value that is not a commit id", async () => {
    const { fetchInto, readAccess } = await setUp();

    await expect(fetchInto("--upload-pack=touch")).rejects.toMatchObject({ code: "invalid_input" });
    expect(readAccess).not.toHaveBeenCalled();
  });
});
