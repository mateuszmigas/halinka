import { createVerify, randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createRepositories } from "../db/repositories";
import { repos } from "../db/schema";
import { appSecretPlace, appStatePlace, SecretCipher } from "../secrets";
import {
  connectApp,
  createConnectedTestServer,
  createLoginTestServer,
  createTestServer,
  FakeGitHub,
  installationOf,
  makeGitHubRepo,
  privateKey,
  publicKey,
  repoOf,
  setUpTestDb,
  stateOf,
  testApiUrl,
  testCipher,
} from "../testing";

const testDb = setUpTestDb();

const setUp = async () => {
  const server = await createTestServer(testDb());
  const gitHub = new FakeGitHub();
  vi.stubGlobal("fetch", gitHub.fetch);
  const start = async (organization?: string) =>
    stateOf(await server.api.github.manifest({ organization }));
  const connected = async () => {
    await server.api.github.connect({ code: "code", state: await start() });
  };
  return { ...server, gitHub, start, connected, refresh: () => server.api.github.refresh() };
};

const setUpLogin = async () => {
  const server = await createLoginTestServer(testDb());
  const admin = await server.adminApi();
  const member = await server.memberApi();
  const gitHub = new FakeGitHub();
  vi.stubGlobal("fetch", gitHub.fetch);
  return { ...server, gitHub, admin, member };
};

const withOtherKey = async () => {
  const server = await setUp();
  await server.connected();
  const { gitHubApp } = createRepositories(testDb());
  const app = await gitHubApp.deleteCurrent();
  const sealedPrivateKey = new SecretCipher(randomBytes(32)).seal("other", "key");
  await gitHubApp.create({
    githubId: 77,
    slug: "halinka-abc",
    ownerLogin: "octo",
    sealedPrivateKey,
    sealedWebhookSecret: app?.sealedWebhookSecret ?? null,
  });
  return server;
};

const withStoredRepo = async () => {
  const server = await createConnectedTestServer(testDb());
  await connectApp(server.api, new FakeGitHub(), [installationOf(10, [repoOf(100, "app")])]);
  return server;
};

describe("POST /api/github/app/manifest", () => {
  it("targets the account of the person without an organization", async () => {
    const { api } = await setUp();

    const { url } = await api.github.manifest({});

    expect(new URL(url).pathname).toBe("/settings/apps/new");
  });

  it("gives a state with only characters that are safe in a URL", async () => {
    const { start } = await setUp();

    expect(await start()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("targets the organization", async () => {
    const { api } = await setUp();

    const { url } = await api.github.manifest({ organization: "acme" });

    expect(new URL(url).pathname).toBe("/organizations/acme/settings/apps/new");
  });

  it("asks for a private App with the return pages", async () => {
    const { api } = await setUp();

    const { manifest } = await api.github.manifest({});

    expect(JSON.parse(manifest)).toMatchObject({
      public: false,
      redirect_url: `${testApiUrl}/github/created`,
      setup_url: `${testApiUrl}/github`,
    });
  });

  it("asks for the permissions of the later tasks, without workflows", async () => {
    const { api } = await setUp();

    const { manifest } = await api.github.manifest({});

    expect((JSON.parse(manifest) as { default_permissions: unknown }).default_permissions).toEqual({
      contents: "write",
      issues: "write",
      metadata: "read",
      pull_requests: "write",
    });
  });

  it("asks for the events of the later tasks on a public host", async () => {
    const { services } = await setUp();

    const { manifest } = await services.gitHubApp.manifest(
      "https://halinka.example.com",
      undefined,
    );

    expect((JSON.parse(manifest) as { default_events: unknown }).default_events).toEqual([
      "issues",
      "issue_comment",
      "pull_request",
      "push",
    ]);
  });

  it("asks for no events on a local host, because GitHub refuses them with no webhook", async () => {
    const { api } = await setUp();

    const { manifest } = await api.github.manifest({});

    expect(JSON.parse(manifest)).not.toHaveProperty("default_events");
  });

  it("refuses an organization that changes the path", async () => {
    const { api } = await setUp();

    await expect(api.github.manifest({ organization: "acme/../x" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("has no webhook on a local host", async () => {
    const { api } = await setUp();

    const { manifest } = await api.github.manifest({});

    expect(JSON.parse(manifest)).not.toHaveProperty("hook_attributes");
  });

  it("has a webhook on a public host", async () => {
    const { services } = await setUp();

    const { manifest } = await services.gitHubApp.manifest(
      "https://halinka.example.com",
      undefined,
    );

    expect(JSON.parse(manifest)).toMatchObject({
      hook_attributes: { url: "https://halinka.example.com/api/github/webhook", active: true },
    });
  });

  it("refuses a second App", async () => {
    const { api, connected } = await setUp();
    await connected();

    await expect(api.github.manifest({})).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a Member", async () => {
    const { member } = await setUpLogin();

    await expect(member.github.manifest({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("POST /api/github/app", () => {
  it("seals the private key and the webhook secret", async () => {
    const { connected } = await setUp();

    await connected();

    const app = await createRepositories(testDb()).gitHubApp.findCurrent();
    expect(app?.sealedPrivateKey).not.toContain("PRIVATE KEY");
    expect(testCipher.open(appSecretPlace(77, "private-key"), app?.sealedPrivateKey ?? "")).toBe(
      privateKey,
    );
    expect(
      testCipher.open(appSecretPlace(77, "webhook-secret"), app?.sealedWebhookSecret ?? ""),
    ).toBe("hook-secret");
  });

  it("answers with the view of the App, without a secret", async () => {
    const { api, start } = await setUp();

    const answer = await api.github.connect({ code: "code", state: await start() });

    expect(answer).toEqual({
      slug: "halinka-abc",
      ownerLogin: "octo",
      isReadable: true,
      installUrl: "https://github.com/apps/halinka-abc/installations/new",
    });
  });

  it("refuses a state that the server did not make", async () => {
    const { api, gitHub } = await setUp();
    const state = new SecretCipher(randomBytes(32)).seal(appStatePlace(undefined), "{}");

    await expect(api.github.connect({ code: "code", state })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(gitHub.requests).toEqual([]);
  });

  it("refuses a state after an hour", async () => {
    const { api, start } = await setUp();
    const state = await start();
    const inTwoHours = Date.now() + 2 * 60 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(inTwoHours);

    await expect(api.github.connect({ code: "code", state })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("refuses the state of another Admin", async () => {
    const { admin, services } = await setUpLogin();
    const other = (await admin.members.list()).find(({ login }) => login === "hubot");
    if (!other) throw new Error("The other member is missing");
    const state = stateOf(await services.gitHubApp.manifest(testApiUrl, other.id));

    await expect(admin.github.connect({ code: "code", state })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("refuses an App of any owner when the Admin is gone", async () => {
    const { services } = await setUpLogin();
    const state = stateOf(await services.gitHubApp.manifest(testApiUrl, 999));

    await expect(services.gitHubApp.connect(999, "code", state)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("refuses an App of another GitHub user", async () => {
    const { admin, gitHub } = await setUpLogin();
    const state = stateOf(await admin.github.manifest({}));
    gitHub.owner = { id: 666, login: "mallory" };

    await expect(admin.github.connect({ code: "code", state })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("mallory owns the App"),
    });
    expect(await createRepositories(testDb()).gitHubApp.findCurrent()).toBeUndefined();
  });

  it("accepts an App of the GitHub user of the Admin", async () => {
    const { admin } = await setUpLogin();
    const state = stateOf(await admin.github.manifest({}));

    await admin.github.connect({ code: "code", state });

    expect(await createRepositories(testDb()).gitHubApp.findCurrent()).toBeDefined();
  });

  it("refuses an App of another account than the organization", async () => {
    const { api, start, gitHub } = await setUp();
    const state = await start("acme");
    gitHub.owner = { id: 666, login: "mallory" };

    await expect(api.github.connect({ code: "code", state })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("accepts the organization in another case", async () => {
    const { api, start, gitHub } = await setUp();
    const state = await start("Acme");
    gitHub.owner = { id: 5, login: "acme" };

    const answer = await api.github.connect({ code: "code", state });

    expect(answer.ownerLogin).toBe("acme");
  });

  it("keeps the code of a second App unused", async () => {
    const { api, start, connected, gitHub } = await setUp();
    const state = await start();
    await connected();
    const conversions = gitHub.requests.length;

    await expect(api.github.connect({ code: "other", state })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(gitHub.requests).toHaveLength(conversions);
  });

  it("keeps the first App when two connect at one time", async () => {
    const { api, start, gitHub } = await setUp();
    const state = await start();
    gitHub.duringConversion = async () => {
      await createRepositories(testDb()).gitHubApp.create({
        githubId: 1,
        slug: "first",
        ownerLogin: "octo",
        sealedPrivateKey: "sealed",
        sealedWebhookSecret: null,
      });
    };

    await expect(api.github.connect({ code: "code", state })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Another App was connected first. Delete it at https://github.com/apps/halinka-abc.",
    });
    expect((await createRepositories(testDb()).gitHubApp.findCurrent())?.slug).toBe("first");
  });

  it("stores an App without a webhook", async () => {
    const { connected, gitHub } = await setUp();
    gitHub.webhookSecret = null;

    await connected();

    const app = await createRepositories(testDb()).gitHubApp.findCurrent();
    expect(app?.sealedWebhookSecret).toBeNull();
  });

  it("says what GitHub answered for a used code", async () => {
    const { api, start, gitHub } = await setUp();
    const state = await start();
    gitHub.refuseWith = Response.json({ message: "Not Found" }, { status: 404 });

    await expect(api.github.connect({ code: "code", state })).rejects.toMatchObject({
      message: "GitHub answered 404: Not Found",
    });
  });

  it("gives the status text of an answer without a body", async () => {
    const { api, start, gitHub } = await setUp();
    const state = await start();
    gitHub.refuseWith = new Response(null, { status: 502, statusText: "Bad Gateway" });

    await expect(api.github.connect({ code: "code", state })).rejects.toMatchObject({
      message: "GitHub answered 502: Bad Gateway",
    });
  });

  it("says that GitHub did not answer", async () => {
    const { api, start } = await setUp();
    const state = await start();
    vi.stubGlobal("fetch", async () => {
      throw new Error("no network");
    });

    await expect(api.github.connect({ code: "code", state })).rejects.toMatchObject({
      message: "GitHub did not answer. Try again.",
    });
  });

  it("refuses an answer of another shape, without its text", async () => {
    const { api, start, gitHub } = await setUp();
    const state = await start();
    gitHub.refuseWith = Response.json({ id: 77, pem: "secret-pem" });

    const failure = await api.github.connect({ code: "code", state }).catch((e: Error) => e);

    expect(failure).toMatchObject({ code: "BAD_REQUEST" });
    expect((failure as Error).message).not.toContain("secret-pem");
  });

  it("refuses a Member", async () => {
    const { member } = await setUpLogin();

    await expect(member.github.connect({ code: "c", state: "s" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("POST /api/github/app/refresh", () => {
  it("records the installations and their repos", async () => {
    const { connected, refresh, gitHub } = await setUp();
    await connected();
    gitHub.installations = [installationOf(10, [repoOf(100, "app")])];

    const { installations } = await refresh();

    expect(installations).toEqual([
      {
        githubId: 10,
        accountLogin: "acme",
        isSuspended: false,
        repos: [{ githubId: 100, owner: "acme", name: "app" }],
      },
    ]);
  });

  it("signs the call with the key of the App", async () => {
    const { connected, refresh, gitHub } = await setUp();
    await connected();

    await refresh();

    const [read] = gitHub.readsOf("/app/installations");
    const [header = "", claims = "", signature = ""] = (read?.authorization ?? "")
      .replace("Bearer ", "")
      .split(".");
    const isValid = createVerify("RSA-SHA256")
      .update(`${header}.${claims}`)
      .verify(publicKey, signature, "base64url");
    expect(isValid).toBe(true);
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toMatchObject({ iss: "77" });
  });

  it("signs a JWT that GitHub accepts for its time", async () => {
    const { connected, refresh, gitHub } = await setUp();
    await connected();

    await refresh();

    const [read] = gitHub.readsOf("/app/installations");
    const claims = (read?.authorization ?? "").split(".")[1] ?? "";
    const { iat, exp } = JSON.parse(Buffer.from(claims, "base64url").toString()) as {
      iat: number;
      exp: number;
    };
    expect(exp - iat).toBeLessThanOrEqual(600);
    expect(iat).toBeLessThan(Date.now() / 1000);
  });

  it("asks for a token that only reads metadata", async () => {
    const { connected, refresh, gitHub } = await setUp();
    await connected();
    gitHub.installations = [installationOf(10, [])];

    await refresh();

    const [mint] = gitHub.readsOf("/app/installations/10/access_tokens");
    expect(mint?.body).toEqual({ permissions: { metadata: "read" } });
  });

  it("reads all pages", async () => {
    const { connected, refresh, gitHub } = await setUp();
    await connected();
    const repos = Array.from({ length: 101 }, (_, index) => repoOf(index + 1, `repo-${index}`));
    gitHub.installations = [installationOf(10, repos)];

    const { installations } = await refresh();

    expect(installations[0]?.repos).toHaveLength(101);
  });

  it("keeps one row for a repo that comes on two pages", async () => {
    const { connected, refresh, gitHub } = await setUp();
    await connected();
    const repos = Array.from({ length: 100 }, (_, index) => repoOf(index + 1, `repo-${index}`));
    gitHub.installations = [installationOf(10, [...repos, repoOf(1, "repo-0")])];

    const { installations } = await refresh();

    expect(installations[0]?.repos).toHaveLength(100);
  });

  it("keeps the row of a repo that stays", async () => {
    const { connected, refresh, gitHub } = await setUp();
    await connected();
    gitHub.installations = [installationOf(10, [repoOf(100, "app")])];
    await refresh();
    const { gitHubApp } = createRepositories(testDb());
    const [before] = await gitHubApp.listRepos();
    gitHub.installations = [installationOf(10, [repoOf(100, "renamed")])];

    await refresh();

    expect(await gitHubApp.listRepos()).toMatchObject([{ id: before?.id, name: "renamed" }]);
  });

  it("removes a repo that left the installation", async () => {
    const { connected, refresh, gitHub } = await setUp();
    await connected();
    gitHub.installations = [installationOf(10, [repoOf(100, "app"), repoOf(101, "gone")])];
    await refresh();
    gitHub.installations = [installationOf(10, [repoOf(100, "app")])];

    const { installations } = await refresh();

    expect(installations[0]?.repos.map(({ name }) => name)).toEqual(["app"]);
  });

  it("keeps the row of a repo after a new install", async () => {
    const { connected, refresh, gitHub } = await setUp();
    await connected();
    gitHub.installations = [installationOf(10, [repoOf(100, "app")])];
    await refresh();
    const { gitHubApp } = createRepositories(testDb());
    const [before] = await gitHubApp.listRepos();
    gitHub.installations = [installationOf(11, [repoOf(100, "app")])];

    await refresh();

    expect(await gitHubApp.listRepos()).toMatchObject([{ id: before?.id }]);
  });

  it("stores one row for a repo under two installations", async () => {
    const { connected, refresh, gitHub } = await setUp();
    await connected();
    gitHub.installations = [
      installationOf(10, [repoOf(100, "app")]),
      installationOf(11, [repoOf(100, "app")]),
    ];

    await refresh();

    expect(await createRepositories(testDb()).gitHubApp.listRepos()).toHaveLength(1);
  });

  it("removes an installation that is gone", async () => {
    const { connected, refresh, gitHub } = await setUp();
    await connected();
    gitHub.installations = [installationOf(10, [repoOf(100, "app")])];
    await refresh();
    gitHub.installations = [];

    const { installations } = await refresh();

    expect(installations).toEqual([]);
    expect(await createRepositories(testDb()).gitHubApp.listRepos()).toEqual([]);
  });

  it("moves a repo to its new installation", async () => {
    const { connected, refresh, gitHub } = await setUp();
    await connected();
    gitHub.installations = [installationOf(10, [repoOf(100, "app")]), installationOf(11, [])];
    await refresh();
    gitHub.installations = [installationOf(10, []), installationOf(11, [repoOf(100, "app")])];

    const { installations } = await refresh();

    const reposOf = (id: number) =>
      installations.find(({ githubId }) => githubId === id)?.repos.map(({ githubId }) => githubId);
    expect(reposOf(10)).toEqual([]);
    expect(reposOf(11)).toEqual([100]);
  });

  it("asks no token for a suspended installation", async () => {
    const { connected, refresh, gitHub } = await setUp();
    await connected();
    gitHub.installations = [installationOf(10, [repoOf(100, "app")], { isSuspended: true })];

    const { installations } = await refresh();

    expect(installations).toMatchObject([{ isSuspended: true, repos: [] }]);
    expect(gitHub.readsOf("/app/installations/10/access_tokens")).toEqual([]);
  });

  it("keeps the rows when GitHub refuses a read", async () => {
    const { connected, refresh, gitHub } = await setUp();
    await connected();
    gitHub.installations = [installationOf(10, [repoOf(100, "app")])];
    await refresh();
    gitHub.refuseWith = Response.json({ message: "Bad credentials" }, { status: 401 });

    await expect(refresh()).rejects.toMatchObject({
      message: "GitHub answered 401: Bad credentials",
    });
    expect(await createRepositories(testDb()).gitHubApp.listRepos()).toHaveLength(1);
  });

  it("stores nothing when the App is disconnected during the read", async () => {
    const { api, connected, refresh, gitHub } = await setUp();
    await connected();
    gitHub.installations = [installationOf(10, [repoOf(100, "app")])];
    gitHub.duringFirstRead = async () => {
      await api.github.disconnect();
    };

    await expect(refresh()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await createRepositories(testDb()).gitHubApp.listInstallations()).toEqual([]);
  });

  it("refuses when no App is connected", async () => {
    const { refresh } = await setUp();

    await expect(refresh()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a refresh with a reason when the key does not open", async () => {
    const { refresh } = await withOtherKey();

    await expect(refresh()).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("the master key changed"),
    });
  });

  it("refuses a Member", async () => {
    const { member } = await setUpLogin();

    await expect(member.github.refresh()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("GET /api/github/app", () => {
  it("shows the App as not readable when the key does not open", async () => {
    const { api } = await withOtherKey();

    const { app } = await api.github.status();

    expect(app?.isReadable).toBe(false);
  });

  it("refuses a Member", async () => {
    const { member } = await setUpLogin();

    await expect(member.github.status()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("GET /api/repos/{id}/workflows", () => {
  it("refuses a read of a `github` repo when the key does not open", async () => {
    const { api } = await withOtherKey();
    const [repo] = await testDb()
      .insert(repos)
      .values({ kind: "github", name: "acme/app", githubRepoId: 100 })
      .returning();

    await expect(api.repos.workflows({ id: repo!.id })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("the master key changed"),
    });
  });
});

describe("DELETE /api/github/app", () => {
  it("disconnects an App whose key does not open", async () => {
    const { api } = await withOtherKey();

    await api.github.disconnect();

    expect((await api.github.status()).app).toBeUndefined();
  });

  it("refuses a disconnect when no App is connected", async () => {
    const { api } = await setUp();

    await expect(api.github.disconnect()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("removes the installations and the repos with a disconnect", async () => {
    const { api, connected, refresh, gitHub } = await setUp();
    await connected();
    gitHub.installations = [installationOf(10, [repoOf(100, "app")])];
    await refresh();

    await api.github.disconnect();

    const { gitHubApp } = createRepositories(testDb());
    expect(await gitHubApp.listInstallations()).toEqual([]);
    expect(await gitHubApp.listRepos()).toEqual([]);
  });

  it("keeps the GitHub link of a repo", async () => {
    const { api } = await withStoredRepo();
    await api.repos.linkGitHub({ id: 1, githubRepoId: 100 });

    await api.github.disconnect();

    expect((await api.repos.list())[0]?.githubRepoId).toBe(100);
  });

  it("refuses a Member", async () => {
    const { member } = await setUpLogin();

    await expect(member.github.disconnect()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("PUT /api/repos/{id}/github", () => {
  it("links a repo of an installation", async () => {
    const { api } = await withStoredRepo();

    await api.repos.linkGitHub({ id: 1, githubRepoId: 100 });

    expect((await api.repos.list())[0]?.githubRepoId).toBe(100);
  });

  it("removes the link", async () => {
    const { api } = await withStoredRepo();
    await api.repos.linkGitHub({ id: 1, githubRepoId: 100 });

    await api.repos.linkGitHub({ id: 1, githubRepoId: null });

    expect((await api.repos.list())[0]?.githubRepoId).toBeUndefined();
  });

  it("refuses a repo on GitHub", async () => {
    const { api } = await withStoredRepo();
    await makeGitHubRepo(testDb(), 1, 100);

    await expect(api.repos.linkGitHub({ id: 1, githubRepoId: null })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("refuses a repo outside the installations", async () => {
    const { api } = await withStoredRepo();

    await expect(api.repos.linkGitHub({ id: 1, githubRepoId: 999 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("refuses an unknown repo of Halinka", async () => {
    const { api } = await withStoredRepo();

    await expect(api.repos.linkGitHub({ id: 9, githubRepoId: 100 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses a Member", async () => {
    const { member } = await setUpLogin();

    await expect(member.repos.linkGitHub({ id: 1, githubRepoId: null })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
