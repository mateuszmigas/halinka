import { describe, expect, it } from "vitest";

import {
  connectApp,
  createConnectedTestServer,
  FakeGitHub,
  installationOf,
  repoOf,
  setUpTestDb,
} from "../testing";

const testDb = setUpTestDb();

const buildPath = ".halinka/workflows/build.yml";

const draft = "schema_version: 1\nname: Draft\nsteps:\n  - { id: build, type: shell, run: ls }\n";

type PublishOptions = { id?: number; workflow?: string; source?: string; baseHash?: string };

const setUp = async () => {
  const server = await createConnectedTestServer(testDb());
  const gitHub = new FakeGitHub();
  await connectApp(server.api, gitHub, [installationOf(10, [repoOf(100, "app")])]);
  gitHub.repoFiles = { ...server.files };
  const repo = await server.api.repos.createGitHub({ githubRepoId: 100 });
  const { hash } = await server.api.repos.workflow({ id: repo.id, workflow: "build" });
  gitHub.requests.length = 0;
  const publish = (changes: PublishOptions = {}) =>
    server.api.repos.publishWorkflow({
      id: repo.id,
      workflow: "build",
      source: draft,
      baseHash: hash,
      ...changes,
    });
  const writes = () =>
    gitHub.requests.filter(
      ({ method, url }) => method === "POST" && url.pathname.startsWith("/repos/"),
    );
  const bodyOf = (pathname: string) =>
    writes().find(({ url }) => url.pathname === `/repos/acme/app/${pathname}`)?.body;
  return { ...server, gitHub, repo, hash, publish, writes, bodyOf };
};

describe("POST /api/repos/{id}/workflows/{workflow}/publish", () => {
  it("answers the URL of the pull request", async () => {
    const { publish } = await setUp();

    expect(await publish()).toEqual({ url: "https://github.com/acme/app/pull/1" });
  });

  it("opens a draft on the default branch", async () => {
    const { publish, gitHub } = await setUp();

    await publish();

    expect(gitHub.pulls[0]?.body).toMatchObject({ draft: true, base: "main" });
  });

  it("changes only the file of the draft, on the tree of the tip", async () => {
    const { publish, bodyOf } = await setUp();

    await publish();

    expect(bodyOf("git/trees")).toEqual({
      base_tree: "base-tree",
      tree: [{ path: buildPath, mode: "100644", type: "blob", content: draft }],
    });
  });

  it("makes one commit with the tip as its parent", async () => {
    const { publish, bodyOf, gitHub } = await setUp();

    await publish();

    expect(bodyOf("git/commits")).toMatchObject({ tree: "new-tree", parents: [gitHub.head] });
  });

  it("makes the branch after the commit", async () => {
    const { publish, writes } = await setUp();

    await publish();

    expect(writes().map(({ url }) => url.pathname.split("/").at(-1))).toEqual([
      "trees",
      "commits",
      "refs",
      "pulls",
    ]);
  });

  it("makes the branch at the new commit", async () => {
    const { publish, gitHub } = await setUp();

    await publish();

    expect([...gitHub.branches.values()]).toEqual(["new-commit"]);
  });

  it("asks for a token of this action only", async () => {
    const { publish, gitHub } = await setUp();

    await publish();

    expect(gitHub.readsOf("/app/installations/10/access_tokens").at(-1)?.body).toEqual({
      repository_ids: [100],
      permissions: { contents: "write", pull_requests: "write", metadata: "read" },
    });
  });

  it("gives the same pull request to the same draft", async () => {
    const { publish, gitHub } = await setUp();
    await publish();

    expect(await publish()).toEqual({ url: "https://github.com/acme/app/pull/1" });
    expect(gitHub.pulls).toHaveLength(1);
  });

  it("makes no second commit for the same draft", async () => {
    const { publish, writes } = await setUp();
    await publish();
    const before = writes().length;

    await publish();

    expect(writes()).toHaveLength(before);
  });

  it("gives another draft another branch", async () => {
    const { publish, gitHub } = await setUp();
    await publish();

    await publish({ source: `${draft}# more\n` });

    expect(gitHub.branches.size).toBe(2);
  });

  it("opens a new pull request after a person closed the first", async () => {
    const { publish, gitHub } = await setUp();
    await publish();
    gitHub.pulls[0]!.state = "closed";

    expect(await publish()).toEqual({ url: "https://github.com/acme/app/pull/2" });
  });

  it("makes the pull request after a failure of the first try", async () => {
    const { publish, gitHub } = await setUp();
    gitHub.refuseWrite = (pathname) => pathname.endsWith("/pulls");
    await expect(publish()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    gitHub.refuseWrite = undefined;

    expect(await publish()).toEqual({ url: "https://github.com/acme/app/pull/1" });
  });

  it("takes the branch of a publish that came first", async () => {
    const { publish, gitHub } = await setUp();
    gitHub.refuseWrite = (pathname) => {
      if (!pathname.endsWith("/git/refs")) return false;
      const { body } = gitHub.requests.at(-1)!;
      gitHub.branches.set((body as { ref: string }).ref.replace("refs/heads/", ""), "x");
      return true;
    };

    expect(await publish()).toEqual({ url: "https://github.com/acme/app/pull/1" });
  });

  it("gives the pull request of a publish that came first", async () => {
    const { publish, gitHub } = await setUp();
    gitHub.refuseWrite = (pathname) => {
      if (!pathname.endsWith("/pulls")) return false;
      gitHub.pulls.push({
        head: [...gitHub.branches.keys()][0]!,
        state: "open",
        url: "https://github.com/acme/app/pull/9",
        body: {},
      });
      return true;
    };

    expect(await publish()).toEqual({ url: "https://github.com/acme/app/pull/9" });
  });

  it("does not take a branch with the same start for this draft", async () => {
    const { publish, gitHub, bodyOf } = await setUp();
    await publish();
    const [branch] = [...gitHub.branches.keys()];
    gitHub.branches.delete(branch!);
    gitHub.branches.set(`${branch}-other`, "x");
    gitHub.pulls.length = 0;
    gitHub.requests.length = 0;

    await publish();

    expect(bodyOf("git/refs")).toBeDefined();
  });

  it("refuses a URL outside github.com", async () => {
    const { publish, gitHub } = await setUp();
    await publish();
    gitHub.pulls[0]!.url = "https://evil.test/pull/1";

    await expect(publish()).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("leaves no branch when the commit fails", async () => {
    const { publish, gitHub } = await setUp();
    gitHub.refuseWrite = (pathname) => pathname.endsWith("/git/commits");

    await expect(publish()).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(gitHub.branches.size).toBe(0);
  });

  it("sends no name of the draft in the text", async () => {
    const { publish, writes } = await setUp();

    await publish({
      source:
        "schema_version: 1\nname: Fixes #1 @octo\nsteps:\n  - { id: build, type: shell, run: ls }\n",
    });

    expect(
      JSON.stringify(writes().filter(({ url }) => !url.pathname.endsWith("trees"))),
    ).not.toContain("@octo");
  });

  it("holds the path and the login in a fence", async () => {
    const { publish, bodyOf } = await setUp();

    await publish();

    expect(bodyOf("pulls")).toMatchObject({
      title: "Publish a workflow draft",
      body: `Published from a draft in Halinka.\n\n\`\`\`\n${buildPath}\nRequested by local\n\`\`\``,
    });
  });

  it("makes a fence longer than the backticks of a file name", async () => {
    const { publish, bodyOf, gitHub, api, repo } = await setUp();
    const named = ".halinka/workflows/a````b.yml";
    gitHub.repoFiles = { [named]: draft };
    const { hash } = await api.repos.workflow({ id: repo.id, workflow: named });

    await publish({ source: `${draft}# more\n`, baseHash: hash, workflow: named });

    expect(bodyOf("pulls")).toMatchObject({ body: expect.stringContaining("`````\n") });
  });

  it("refuses a stale draft", async () => {
    const { publish } = await setUp();

    await expect(publish({ baseHash: "other-hash" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a draft that does not parse", async () => {
    const { publish } = await setUp();

    await expect(publish({ source: "name: [" })).rejects.toMatchObject({
      code: "INVALID_WORKFLOW",
    });
  });

  it("refuses a draft equal to the file", async () => {
    const { publish, files } = await setUp();

    await expect(publish({ source: files[buildPath] })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it.each([
    ["a stale draft", () => ({ baseHash: "other-hash" })],
    ["a draft that does not parse", () => ({ source: "name: [" })],
    [
      "a draft equal to the file",
      (files: Record<string, string>) => ({ source: files[buildPath] }),
    ],
  ])(
    "writes nothing for %s",
    async (_, changesOf: (files: Record<string, string>) => PublishOptions) => {
      const { publish, writes, files } = await setUp();

      await publish(changesOf(files)).catch(() => {});

      expect(writes()).toEqual([]);
    },
  );

  it("refuses a local repo", async () => {
    const { publish, api } = await setUp();
    const repos = await api.repos.list();
    const { id } = repos.find(({ kind }) => kind === "local")!;
    const { hash } = await api.repos.workflow({ id, workflow: "build" });

    await expect(publish({ baseHash: hash, id })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("is local"),
    });
  });

  it("refuses when no App is connected", async () => {
    const { publish, api } = await setUp();
    await api.github.disconnect();

    await expect(publish()).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
