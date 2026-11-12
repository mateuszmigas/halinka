import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { createRepositories } from "../db/repositories";
import { repos } from "../db/schema";
import {
  connectApp,
  createConnectedTestServer,
  deliverEvent,
  devcontainerConfig,
  FakeGitHub,
  installationOf,
  repoOf,
  setUpTestDb,
} from "../testing";

const testDb = setUpTestDb();

const senderId = 500;

const workflowOf = (name: string, on: string[], extra: string[] = []) =>
  [
    "schema_version: 1",
    `name: ${name}`,
    "inputs:",
    "  issue_number: { type: number, required: true }",
    ...extra,
    "on:",
    ...on,
    "steps:",
    "  - { id: build, type: shell, run: ls }",
    "",
  ].join("\n");

const onOpened = [
  "  issues:",
  "    types: [opened]",
  "    inputs:",
  "      issue_number: ${{ event.issue.number }}",
];

const fix = workflowOf("Fix", onOpened);

const fixPath = ".halinka/workflows/fix.yml";
const failPath = ".halinka/workflows/fail.yml";
const otherPath = ".halinka/workflows/other.yml";

const secret = "Secret text of the issue";

const payload = (fields: object = {}, issue: object = {}) => ({
  action: "opened",
  issue: {
    number: 7,
    title: secret,
    body: secret,
    html_url: "https://github.test/7",
    user: { login: "octo" },
    labels: [],
    ...issue,
  },
  sender: { id: senderId, login: "octo" },
  repository: { id: 100 },
  ...fields,
});

const connected = async () => {
  const server = await createConnectedTestServer(testDb());
  const gitHub = new FakeGitHub();
  await connectApp(server.api, gitHub, [installationOf(10, [repoOf(100, "app")])]);
  const deliver = (body: object = payload(), event = "issues", id = "delivery-1") =>
    deliverEvent(server, testDb(), { id, event, body });
  return { ...server, gitHub, deliver };
};

const setUp = async (repoFiles: Record<string, string>) => {
  const server = await connected();
  const repo = await server.api.repos.createGitHub({ githubRepoId: 100 });
  server.gitHub.repoFiles = repoFiles;
  server.gitHub.requests.length = 0;
  const member = await createRepositories(testDb()).member.create({
    githubId: String(senderId),
    login: "octo",
    role: "member",
  });
  const runs = async () => (await server.api.runs.list({ repoId: repo.id })).runs;
  const firstRun = async () => {
    const [created] = await runs();
    return server.services.run.get(created!.id);
  };
  return { ...server, member: member!, runs, firstRun };
};

const branchFromTitle = workflowOf(
  "Fail",
  [...onOpened, "      title: ${{ event.issue.title }}"],
  ["  title: { type: string, required: true }"],
).replace("steps:\n", "branch:\n  name: ${{ inputs.title }}\nsteps:\n");

const labeled = payload({ action: "labeled", label: { name: "halinka" } });

const issueToPullRequestExample = () =>
  readFile(new URL("../../../../docs/examples/issue-to-pr.yml", import.meta.url), "utf8");

const review = workflowOf("Review", [
  "  pull_request:",
  "    types: [opened]",
  "    inputs:",
  "      issue_number: ${{ event.pull_request.number }}",
]);

const headSha = "a".repeat(40);

const pullRequestOf = (fields: object = {}, headFields: object = {}) => ({
  action: "opened",
  pull_request: {
    number: 7,
    state: "open",
    title: secret,
    body: secret,
    html_url: "https://github.test/pull/7",
    user: { login: "octo" },
    draft: false,
    labels: [],
    head: { ref: "fix/7", sha: headSha, repo: { id: 100 }, ...headFields },
    base: { ref: "main" },
    ...fields,
  },
  sender: { id: senderId, login: "octo" },
  repository: { id: 100, default_branch: "main" },
});

const deliverOf = (deliver: (body: object, event: string) => Promise<unknown>) => (body: object) =>
  deliver(body, "pull_request");

const commenting = review.replace(
  "  - { id: build, type: shell, run: ls }",
  "  - { id: report, type: github, action: comment_on_pull_request, body: Done }",
);

const startedCommentStep = async () => {
  const server = await setUp({
    [fixPath]: commenting,
    ".halinka/config.yml": devcontainerConfig,
    ".devcontainer/devcontainer.json": "{}",
  });
  await server.deliver(pullRequestOf(), "pull_request");
  const { lease } = await server.claimOne([], "devcontainer");
  const stepRunId = await server.plane.startStep(lease, "report");
  return { ...server, lease, stepRunId };
};

const withOtherWorkflow = (source: string) => setUp({ [failPath]: source, [otherPath]: fix });

describe("POST /api/github/webhook", () => {
  it("gives the mapped inputs to the run", async () => {
    const { deliver, firstRun } = await setUp({ [fixPath]: fix });

    await deliver();

    expect(await firstRun()).toMatchObject({ inputs: { issue_number: 7 } });
  });

  it("marks the run as untrusted", async () => {
    const { deliver, firstRun } = await setUp({ [fixPath]: fix });

    await deliver();

    expect(await firstRun()).toMatchObject({ untrusted: true });
  });

  it("starts the run from the tip that it read", async () => {
    const { deliver, firstRun, gitHub } = await setUp({ [fixPath]: fix });

    await deliver();

    expect(await firstRun()).toMatchObject({ baseSha: gitHub.head });
  });

  it("gives the mapped member as the author", async () => {
    const { deliver, firstRun, member } = await setUp({ [fixPath]: fix });

    await deliver();

    expect(await firstRun()).toMatchObject({ authorId: member.id });
  });

  it("records the run", async () => {
    const { deliver, runs } = await setUp({ [fixPath]: fix });

    const result = await deliver();

    const [created] = await runs();
    expect(result).toBe(`${fixPath}: The run ${created!.id} started.`);
  });

  it("starts a run from a comment", async () => {
    const onComment = [
      "  issue_comment:",
      "    starts_with: /halinka",
      "    inputs:",
      "      issue_number: ${{ event.issue.number }}",
    ];
    const { deliver, runs } = await setUp({ [fixPath]: workflowOf("Fix", onComment) });

    await deliver(
      payload({
        action: "created",
        comment: { body: "/halinka go", html_url: "https://github.test/c", user: null },
      }),
      "issue_comment",
    );

    expect(await runs()).toHaveLength(1);
  });

  it("reads the definitions once for two workflows", async () => {
    const { deliver, gitHub } = await setUp({ [fixPath]: fix, [otherPath]: fix });

    await deliver();

    expect(gitHub.readsOf("/repos/acme/app/git/ref/heads/main")).toHaveLength(1);
  });

  it("starts each workflow that matches", async () => {
    const { deliver, runs } = await setUp({ [fixPath]: fix, [otherPath]: fix });

    await deliver();

    expect(await runs()).toHaveLength(2);
  });

  it("records that no workflow starts", async () => {
    const { deliver, runs } = await setUp({ [fixPath]: fix });

    const result = await deliver(payload({ action: "reopened" }));

    expect(result).toBe("No workflow starts for this event.");
    expect(await runs()).toEqual([]);
  });

  it("starts a review from the pull request review example", async () => {
    const source = await readFile(
      new URL("../../../../docs/examples/pr-review.yml", import.meta.url),
      "utf8",
    );
    const { deliver, firstRun } = await setUp({ [fixPath]: source });

    await deliver(
      {
        action: "opened",
        pull_request: {
          number: 7,
          state: "open",
          title: "Fix",
          body: null,
          html_url: "https://github.test/pull/7",
          user: { login: "octo" },
          head: { ref: "fix/7", sha: "a".repeat(40), repo: { id: 100 } },
          base: { ref: "main" },
        },
        sender: { id: senderId, login: "octo" },
        repository: { id: 100, default_branch: "main" },
      },
      "pull_request",
    );

    expect(await firstRun()).toMatchObject({ inputs: { pr_number: 7, title: "Fix" } });
  });

  it("starts a run for the label of the issue to pull request example", async () => {
    const { deliver, firstRun } = await setUp({ [fixPath]: await issueToPullRequestExample() });

    await deliver(labeled);

    expect(await firstRun()).toMatchObject({
      branch: "halinka/issue-7",
      inputs: { issue_number: 7, issue_title: secret, issue_body: secret },
    });
  });

  it("starts a run of the issue to pull request example for an issue with no text", async () => {
    const { deliver, runs } = await setUp({ [fixPath]: await issueToPullRequestExample() });

    await deliver(payload({ action: "labeled", label: { name: "halinka" } }, { body: null }));

    expect(await runs()).toHaveLength(1);
  });

  it("refuses a second run of the issue while the first is retained", async () => {
    const { deliver, runs } = await setUp({ [fixPath]: await issueToPullRequestExample() });
    await deliver(labeled, "issues", "first");
    const [holder] = await runs();

    const result = await deliver(labeled, "issues", "second");

    expect(result).toBe(`${fixPath}: The run ${holder!.id} holds the branch of this run.`);
  });

  it("starts on the head of the pull request, with the definition of the tip", async () => {
    const { deliver, firstRun, gitHub } = await setUp({ [fixPath]: review });

    await deliverOf(deliver)(pullRequestOf());

    expect(await firstRun()).toMatchObject({
      baseSha: headSha,
      definitionSha: gitHub.head,
      pullRequestNumber: 7,
      untrusted: true,
    });
  });

  it("starts no run for a pull request of a fork", async () => {
    const { deliver, runs } = await setUp({ [fixPath]: review });

    await deliverOf(deliver)(pullRequestOf({}, { repo: { id: 999 } }));

    expect(await runs()).toEqual([]);
  });

  it("refuses Open PR for a run of a pull request", async () => {
    const { deliver, firstRun } = await setUp({ [fixPath]: review });

    await deliverOf(deliver)(pullRequestOf());

    expect(await firstRun()).toMatchObject({ canOpenPullRequest: false });
  });

  it("skips a setup with secrets for a pull request, with no secret stored", async () => {
    const config = [
      "schema_version: 1",
      "server: local",
      "devcontainer: .devcontainer/devcontainer.json",
      "setup:",
      "  run: pnpm install",
      "  secrets: [NPM_TOKEN]",
    ].join("\n");
    const { deliver, firstRun } = await setUp({
      [fixPath]: review,
      ".halinka/config.yml": config,
      ".devcontainer/devcontainer.json": "{}",
    });

    await deliverOf(deliver)(pullRequestOf());

    expect(await firstRun()).toMatchObject({ isSetupSkipped: true });
  });

  it("skips a setup with secrets when the head is also the tip", async () => {
    const config = [
      "schema_version: 1",
      "server: local",
      "devcontainer: .devcontainer/devcontainer.json",
      "setup:",
      "  run: pnpm install",
      "  secrets: [NPM_TOKEN]",
    ].join("\n");
    const { deliver, firstRun, gitHub } = await setUp({
      [fixPath]: review,
      ".halinka/config.yml": config,
      ".devcontainer/devcontainer.json": "{}",
    });

    await deliver(pullRequestOf({}, { sha: gitHub.head }), "pull_request");

    expect(await firstRun()).toMatchObject({ isSetupSkipped: true });
  });

  it("starts a run from an issue with the same commit twice", async () => {
    const { deliver, firstRun, gitHub } = await setUp({ [fixPath]: fix });

    await deliver();

    expect(await firstRun()).toMatchObject({
      baseSha: gitHub.head,
      definitionSha: gitHub.head,
      pullRequestNumber: undefined,
    });
  });

  it("stops for a repo that the server does not have", async () => {
    const { deliver, gitHub } = await setUp({ [fixPath]: fix });

    const result = await deliver(payload({ repository: { id: 999 } }));

    expect(result).toBe("The server has no GitHub repo with this id.");
    expect(gitHub.requests).toEqual([]);
  });

  it("stops for a repo that the server deletes", async () => {
    const { deliver, gitHub } = await setUp({ [fixPath]: fix });
    await testDb().update(repos).set({ deletingAt: new Date() });

    const result = await deliver();

    expect(result).toBe("The server has no GitHub repo with this id.");
    expect(gitHub.requests).toEqual([]);
  });

  it("stops for a local repo with a link to the GitHub repo", async () => {
    const { api, deliver, gitHub } = await connected();
    const [local] = await api.repos.list();
    await api.repos.linkGitHub({ id: local!.id, githubRepoId: 100 });
    gitHub.requests.length = 0;

    const result = await deliver();

    expect(result).toBe("The server has no GitHub repo with this id.");
    expect(gitHub.requests).toEqual([]);
  });

  it("stops for a sender that is no member", async () => {
    const { deliver, gitHub } = await setUp({ [fixPath]: fix });

    const result = await deliver(payload({ sender: { id: 1, login: "other" } }));

    expect(result).toBe("The sender is not a member.");
    expect(gitHub.requests).toEqual([]);
  });

  it("records a payload of another shape", async () => {
    const { deliver, gitHub } = await setUp({ [fixPath]: fix });

    const result = await deliver({ action: "opened" });

    expect(result).toBe("The payload of this event is not valid.");
    expect(gitHub.requests).toEqual([]);
  });

  it("records a failed read of the definitions", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deliver, gitHub } = await setUp({ [fixPath]: fix });
    gitHub.refuseWith = Response.json({ message: "Down" }, { status: 500 });

    expect(await deliver()).toBe("GitHub answered 500: Down");
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "GitHub answered 500: Down" }),
    );
  });

  it("records a workflow that does not parse", async () => {
    const { deliver } = await withOtherWorkflow("name: [");

    const result = await deliver();

    expect(result).toContain(`${failPath}: The workflow is not valid.`);
  });

  it("starts the other workflows when one does not parse", async () => {
    const { deliver, runs } = await withOtherWorkflow("name: [");

    const result = await deliver();

    const [created] = await runs();
    expect(result).toContain(`${otherPath}: The run ${created!.id} started.`);
  });

  it("records a mapping that fails on an issue with no user", async () => {
    const { deliver } = await withOtherWorkflow(
      workflowOf(
        "Fail",
        [...onOpened, "      login: ${{ event.issue.user.login }}"],
        ["  login: { type: string, required: true }"],
      ),
    );

    const result = await deliver(payload({}, { user: null }));

    expect(result).toContain(`${failPath}: event.issue.user.login is not set.`);
  });

  it("records a required input with an empty value", async () => {
    const { deliver } = await withOtherWorkflow(
      workflowOf(
        "Fail",
        [...onOpened, "      text: ${{ event.issue.body ?? '' }}"],
        ["  text: { type: string, required: true }"],
      ),
    );

    const result = await deliver(payload({}, { body: null }));

    expect(result).toContain(`${failPath}: Check the inputs. text: Give a value`);
  });

  it("records another refusal with its message", async () => {
    const { deliver } = await setUp({ ".halinka/config.yml": "nope: [", [fixPath]: fix });

    expect(await deliver()).toContain(`${fixPath}: .halinka/config.yml is not valid`);
  });

  it("records an invalid branch name with no text of the event", async () => {
    const { deliver } = await withOtherWorkflow(branchFromTitle);

    const result = await deliver();

    expect(result).toContain(`${failPath}: The branch name is not valid.`);
    expect(result).not.toContain(secret);
  });

  it("records an invalid concurrency group with no text of the event", async () => {
    const groupFromTitle = branchFromTitle.replace(
      "branch:\n  name: ${{ inputs.title }}\n",
      "concurrency:\n  group: ${{ inputs.title }}\n",
    );
    const { deliver } = await withOtherWorkflow(groupFromTitle);

    const result = await deliver(payload({}, { title: `${secret}${"x".repeat(200)}` }));

    expect(result).toContain(`${failPath}: The concurrency group is not valid.`);
    expect(result).not.toContain(secret);
  });

  it("records the name of a generated branch with no text of the event", async () => {
    const { deliver } = await setUp({ [failPath]: branchFromTitle });

    const result = await deliver(payload({}, { title: "halinka/run-5" }));

    expect(result).toBe(`${failPath}: The branch name is for a run with that id.`);
  });

  it("records the default branch with no text of the event", async () => {
    const { deliver } = await setUp({ [failPath]: branchFromTitle });

    const result = await deliver(payload({}, { title: "main" }));

    expect(result).toBe(`${failPath}: The branch name is the default branch of the repo.`);
  });

  it("records the run that holds the branch name with no text of the event", async () => {
    const { deliver, runs } = await setUp({ [failPath]: branchFromTitle });
    const held = payload({}, { title: "held-title" });
    await deliver(held, "issues", "first");
    const [holder] = await runs();

    const result = await deliver(held, "issues", "second");

    expect(result).toBe(`${failPath}: The run ${holder!.id} holds the branch of this run.`);
  });
});

describe("sync", () => {
  it("gives the runner the number of the pull request of a run at the claim", async () => {
    const server = await setUp({
      [fixPath]: commenting,
      ".halinka/config.yml": devcontainerConfig,
      ".devcontainer/devcontainer.json": "{}",
    });
    await server.deliver(pullRequestOf(), "pull_request");

    const claimed = await server.claimOne([], "devcontainer");

    expect(claimed.pullRequestNumber).toBe(7);
  });
});

describe("readCommentAccess", () => {
  it("gives the number of the run and a token", async () => {
    const { plane, lease, stepRunId } = await startedCommentStep();

    await expect(plane.readCommentAccess(lease, stepRunId)).resolves.toMatchObject({
      pullRequestNumber: 7,
      github: { owner: expect.any(String), name: "app", token: expect.any(String) },
    });
  });

  it("gives the stored comment and no token at a repeat", async () => {
    const { plane, lease, stepRunId } = await startedCommentStep();
    const url = "https://github.test/pull/7#issuecomment-1";
    await plane.storeComment(lease, stepRunId, url);

    await expect(plane.readCommentAccess(lease, stepRunId)).resolves.toEqual({ url });
  });

  it("refuses a step that does not comment", async () => {
    const server = await setUp({
      [fixPath]: review,
      ".halinka/config.yml": devcontainerConfig,
      ".devcontainer/devcontainer.json": "{}",
    });
    await server.deliver(pullRequestOf(), "pull_request");
    const { lease } = await server.claimOne([], "devcontainer");
    const stepRunId = await server.plane.startStep(lease, "build");

    await expect(server.plane.readCommentAccess(lease, stepRunId)).rejects.toThrow(
      "does not comment",
    );
  });

  it("refuses a test run", async () => {
    const { api, plane, claimOne } = await setUp({
      [fixPath]: commenting,
      ".halinka/config.yml": devcontainerConfig,
      ".devcontainer/devcontainer.json": "{}",
    });
    const { hash } = await api.repos.workflow({ id: 2, workflow: "fix" });
    await api.runs.test({
      repoId: 2,
      workflow: "fix",
      source: `${commenting}\n`,
      baseHash: hash,
      inputs: { issue_number: "7" },
    });
    const { lease } = await claimOne([], "devcontainer");
    const stepRunId = await plane.startStep(lease, "report");

    await expect(plane.readCommentAccess(lease, stepRunId)).rejects.toThrow("test run");
  });

  it("refuses a run with no pull request", async () => {
    const { api, plane, claimOne } = await setUp({
      [fixPath]: commenting,
      ".halinka/config.yml": devcontainerConfig,
      ".devcontainer/devcontainer.json": "{}",
    });
    await api.runs.create({ repoId: 2, workflow: "fix", inputs: { issue_number: "7" } });
    const { lease } = await claimOne([], "devcontainer");
    const stepRunId = await plane.startStep(lease, "report");

    await expect(plane.readCommentAccess(lease, stepRunId)).rejects.toThrow(
      "did not start from a pull request",
    );
  });
});
