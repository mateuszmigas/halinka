import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { createRepositories, inTransaction } from "../db/repositories";
import { workflowSchedules } from "../db/schema";
import {
  connectApp,
  createConnectedTestServer,
  deliverEvent,
  devcontainerConfig,
  devcontainerRunner,
  FakeGitHub,
  installationOf,
  repoOf,
  setUpTestDb,
} from "../testing";

const testDb = setUpTestDb();

const nightlyPath = ".halinka/workflows/nightly.yml";

const workflowOf = (schedule: string, extra: string[] = []) =>
  [
    "schema_version: 1",
    "name: Nightly",
    ...extra,
    "on:",
    "  cron:",
    `    schedule: "${schedule}"`,
    "steps:",
    "  - { id: build, type: shell, run: ls }",
    "",
  ].join("\n");

const daily = workflowOf("0 6 * * *");

const noSchedule =
  "schema_version: 1\nname: Nightly\nsteps:\n  - { id: build, type: shell, run: ls }\n";

const grouped = workflowOf("0 6 * * *", ["concurrency:", "  group: nightly"]);

const firstFire = new Date("2100-01-01T06:00:00Z");
const beforeFire = new Date("2100-01-01T05:59:00Z");
const nextDay = new Date("2100-01-02T06:00:00Z");

const push = { ref: "refs/heads/main", repository: { id: 100, default_branch: "main" } };

const withApp = async () => {
  const server = await createConnectedTestServer(testDb());
  const gitHub = new FakeGitHub();
  await connectApp(server.api, gitHub, [installationOf(10, [repoOf(100, "app")])]);
  return { ...server, gitHub };
};

// Each query goes after the queries that wait already, so other work gets its turns.
const databaseTurns = async (count: number) => {
  for (let turn = 0; turn < count; turn++) await testDb().select().from(workflowSchedules);
};

const setUp = async (repoFiles: Record<string, string>) => {
  const { gitHub, ...server } = await withApp();
  gitHub.repoFiles = repoFiles;
  const repo = await server.api.repos.createGitHub({ githubRepoId: 100 });
  const { workflowSchedule } = createRepositories(testDb());
  const rows = () =>
    testDb().select().from(workflowSchedules).where(eq(workflowSchedules.repoId, repo.id));
  const setNextFire = async (nextFireAt: Date) => {
    for (const row of await rows()) {
      await workflowSchedule.moveNextFire(row, nextFireAt);
    }
  };
  const runs = async () => (await server.api.runs.list({ repoId: repo.id })).runs;
  const deliver = (body: object = push) => deliverEvent(server, testDb(), { event: "push", body });
  const fireAt = (now: Date) => server.services.schedule.fireDue(now);
  return { ...server, gitHub, repo, rows, setNextFire, runs, deliver, fireAt };
};

const due = async (repoFiles: Record<string, string> = { [nightlyPath]: daily }) => {
  const server = await setUp(repoFiles);
  await server.setNextFire(firstFire);
  return server;
};

const refusedRead = () => Response.json({ message: "Down" }, { status: 503 });

describe("POST /api/repos/github", () => {
  it("adds a row for the schedule of a workflow of the repo", async () => {
    const { rows } = await setUp({ [nightlyPath]: daily });

    expect(await rows()).toMatchObject([{ path: nightlyPath, schedule: "0 6 * * *" }]);
  });

  it("adds the repo when the read of its files fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { api, gitHub } = await withApp();
    gitHub.isTruncated = true;

    const repo = await api.repos.createGitHub({ githubRepoId: 100 });

    expect(repo).toMatchObject({ githubRepoId: 100 });
    expect(error).toHaveBeenCalledOnce();
  });
});

describe("POST /api/github/webhook", () => {
  it("adds a schedule row at a push to the default branch", async () => {
    const { gitHub, rows, deliver } = await setUp({});
    gitHub.repoFiles = { [nightlyPath]: daily };

    const result = await deliver();

    expect(result).toBe("The server read the schedules.");
    expect(await rows()).toMatchObject([{ path: nightlyPath }]);
  });

  it("deletes the row of a removed schedule at a push", async () => {
    const { gitHub, rows, deliver } = await setUp({ [nightlyPath]: daily });
    gitHub.repoFiles = { [nightlyPath]: noSchedule };

    await deliver();

    expect(await rows()).toEqual([]);
  });

  it("gives a new time to a changed schedule at a push", async () => {
    const { gitHub, rows, setNextFire, deliver } = await setUp({ [nightlyPath]: daily });
    await setNextFire(firstFire);
    gitHub.repoFiles = { [nightlyPath]: workflowOf("0 7 * * *") };

    await deliver();

    const [row] = await rows();
    expect(row).toMatchObject({ schedule: "0 7 * * *" });
    expect(row!.nextFireAt.getUTCHours()).toBe(7);
  });

  it("keeps the time of a schedule with no change at a push", async () => {
    const { rows, setNextFire, deliver } = await setUp({ [nightlyPath]: daily });
    await setNextFire(firstFire);

    await deliver();

    expect(await rows()).toMatchObject([{ nextFireAt: firstFire }]);
  });

  it("keeps the schedule row of a file that is not valid at a push", async () => {
    const { gitHub, rows, deliver } = await setUp({ [nightlyPath]: daily });
    gitHub.repoFiles = { [nightlyPath]: "name: [" };

    await deliver();

    expect(await rows()).toMatchObject([{ path: nightlyPath }]);
  });

  it("records the failure when the read at a push fails", async () => {
    const { gitHub, deliver } = await setUp({ [nightlyPath]: daily });
    gitHub.refuseWith = Response.json({ message: "Down" }, { status: 503 });

    expect(await deliver()).toBe("GitHub answered 503: Down");
  });

  it("keeps the schedule rows when the read at a push fails", async () => {
    const { gitHub, rows, deliver } = await setUp({ [nightlyPath]: daily });
    gitHub.refuseWith = Response.json({ message: "Down" }, { status: 503 });

    await deliver();

    expect(await rows()).toHaveLength(1);
  });

  it("leaves the schedule rows of another repo at a push", async () => {
    const { deliver, repo } = await setUp({ [nightlyPath]: daily });
    const { repo: repos } = createRepositories(testDb());
    const other = await repos.createGitHub({ name: "acme/other", githubRepoId: 200 });
    await inTransaction(testDb(), ({ workflowSchedule }) =>
      workflowSchedule.rewrite(
        other.id,
        [{ path: nightlyPath, schedule: "0 6 * * *", nextFireAt: firstFire }],
        [],
      ),
    );

    await deliver();

    const all = await testDb().select().from(workflowSchedules);
    expect(new Set(all.map(({ repoId }) => repoId))).toEqual(new Set([repo.id, other.id]));
  });

  it("reads nothing at a push to another branch", async () => {
    const { gitHub, deliver } = await setUp({ [nightlyPath]: daily });
    gitHub.requests.length = 0;

    const result = await deliver({ ...push, ref: "refs/heads/feature" });

    expect(result).toBe("The push is not to the default branch.");
    expect(gitHub.requests).toEqual([]);
  });

  it("reads nothing at a push to a repo that the server does not have", async () => {
    const { gitHub, deliver } = await setUp({ [nightlyPath]: daily });
    gitHub.requests.length = 0;

    const result = await deliver({ ...push, repository: { id: 999, default_branch: "main" } });

    expect(result).toBe("The server has no GitHub repo with this id.");
    expect(gitHub.requests).toEqual([]);
  });

  it("refuses a push with a payload of another shape", async () => {
    const { deliver } = await setUp({});

    expect(await deliver({ ref: "refs/heads/main" })).toBe(
      "The payload of this event is not valid.",
    );
  });
});

describe("syncSchedules", () => {
  it("keeps the schedule row of a newer push when an older read is still open", async () => {
    const { gitHub, repo, services, rows } = await setUp({});
    const opened = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let isHeld = false;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const answer = await gitHub.fetch(input, init);
      if (isHeld || !input.includes("/git/trees/")) return answer;
      isHeld = true;
      opened.resolve();
      await release.promise;
      return answer;
    });

    const older = services.repo.syncSchedules(repo.id);
    await opened.promise;
    gitHub.repoFiles = { [nightlyPath]: daily };
    const newer = services.repo.syncSchedules(repo.id);
    await Promise.race([newer, databaseTurns(100)]);
    release.resolve();
    await Promise.all([older, newer]);

    expect(await rows()).toMatchObject([{ path: nightlyPath }]);
  });
});

describe("fireDue", () => {
  it("starts no run before the time of the schedule", async () => {
    const { fireAt, runs } = await due();

    await fireAt(beforeFire);

    expect(await runs()).toEqual([]);
  });

  it("records the run that it starts at the time of the schedule", async () => {
    const { fireAt, runs, rows } = await due();

    await fireAt(firstFire);

    const [run] = await runs();
    expect(await rows()).toMatchObject([{ lastResult: `The run ${run!.id} started.` }]);
  });

  it("starts a run with no author", async () => {
    const { fireAt, runs, services } = await due();

    await fireAt(firstFire);

    const [run] = await runs();
    expect(await services.run.get(run!.id)).toMatchObject({ authorId: undefined });
  });

  it("marks the run as untrusted, so it needs a container", async () => {
    const { fireAt, runs, services } = await due();

    await fireAt(firstFire);

    const [run] = await runs();
    expect(await services.run.get(run!.id)).toMatchObject({ untrusted: true });
  });

  it("starts one run when two fires reach the same time", async () => {
    const { fireAt, runs } = await due();

    await Promise.all([fireAt(firstFire), fireAt(firstFire)]);

    expect(await runs()).toHaveLength(1);
  });

  it("gives the inputs of the mapping to the run", async () => {
    const source = [
      "schema_version: 1",
      "name: Nightly",
      "inputs:",
      "  target: { type: string, required: true }",
      "on:",
      "  cron:",
      '    schedule: "0 6 * * *"',
      "    inputs:",
      "      target: docs",
      "steps:",
      "  - { id: build, type: shell, run: ls }",
      "",
    ].join("\n");
    const { fireAt, runs, services } = await due({ [nightlyPath]: source });

    await fireAt(firstFire);

    const [run] = await runs();
    expect(await services.run.get(run!.id)).toMatchObject({ inputs: { target: "docs" } });
  });

  it("starts the run from the tip at the fire", async () => {
    const { fireAt, runs, services, gitHub } = await due();
    gitHub.head = "d".repeat(40);

    await fireAt(firstFire);

    const [run] = await runs();
    expect(await services.run.get(run!.id)).toMatchObject({ baseSha: gitHub.head });
  });

  it("gives the schedule its next time after the fire", async () => {
    const { fireAt, rows } = await due();

    await fireAt(firstFire);

    expect(await rows()).toMatchObject([{ nextFireAt: nextDay }]);
  });

  it("starts one run for all the times of a long downtime", async () => {
    const { fireAt, runs, rows } = await due();
    const weekLater = new Date("2100-01-08T12:00:00Z");

    await fireAt(weekLater);
    await fireAt(weekLater);

    expect(await runs()).toHaveLength(1);
    expect(await rows()).toMatchObject([{ nextFireAt: new Date("2100-01-09T06:00:00Z") }]);
  });

  it("starts no run when the tip has another schedule", async () => {
    const { fireAt, runs, gitHub } = await due();
    gitHub.repoFiles = { [nightlyPath]: workflowOf("0 7 * * *") };

    await fireAt(firstFire);

    expect(await runs()).toEqual([]);
  });

  it("uses the schedule of the tip when it differs", async () => {
    const { fireAt, rows, gitHub } = await due();
    gitHub.repoFiles = { [nightlyPath]: workflowOf("0 7 * * *") };

    await fireAt(firstFire);

    expect(await rows()).toMatchObject([
      {
        schedule: "0 7 * * *",
        nextFireAt: new Date("2100-01-01T07:00:00Z"),
        lastResult: "The tip has another schedule.",
      },
    ]);
  });

  it("deletes the row when the tip has no such workflow", async () => {
    const { fireAt, runs, rows, gitHub } = await due();
    gitHub.repoFiles = {};

    await fireAt(firstFire);

    expect(await runs()).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("adds the row of a new workflow that a lost push did not add", async () => {
    const { fireAt, rows, gitHub } = await due();
    const otherPath = ".halinka/workflows/other.yml";
    gitHub.repoFiles = { [nightlyPath]: daily, [otherPath]: daily };

    await fireAt(firstFire);

    expect((await rows()).map(({ path }) => path).sort()).toEqual([nightlyPath, otherPath]);
  });

  it("records a file that is not valid", async () => {
    const { fireAt, runs, rows, gitHub } = await due();
    gitHub.repoFiles = { [nightlyPath]: "name: [" };

    await fireAt(firstFire);

    expect(await runs()).toEqual([]);
    expect(await rows()).toMatchObject([{ lastResult: "The workflow is not valid." }]);
  });

  it("keeps the next time of a file that is not valid", async () => {
    const { fireAt, rows, gitHub } = await due();
    gitHub.repoFiles = { [nightlyPath]: "name: [" };

    await fireAt(firstFire);

    expect(await rows()).toMatchObject([{ nextFireAt: nextDay }]);
  });

  it("starts nothing when a run of its group is queued", async () => {
    const { fireAt, runs } = await due({ [nightlyPath]: grouped });
    await fireAt(firstFire);

    await fireAt(nextDay);

    expect(await runs()).toHaveLength(1);
  });

  it("records the skip when a run of its group is queued", async () => {
    const { fireAt, rows } = await due({ [nightlyPath]: grouped });
    await fireAt(firstFire);

    await fireAt(nextDay);

    expect(await rows()).toMatchObject([
      {
        lastResult: "A run of this workflow or its concurrency group is queued, so no run started.",
      },
    ]);
  });

  it("starts a run when a run of its group is running", async () => {
    const { fireAt, runs, plane } = await due({
      [nightlyPath]: grouped,
      ".halinka/config.yml": devcontainerConfig,
      ".devcontainer/devcontainer.json": '{ "image": "node" }',
    });
    await fireAt(firstFire);
    await plane.sync({ held: [], capacity: 1, capabilities: devcontainerRunner });

    await fireAt(nextDay);

    expect(await runs()).toHaveLength(2);
  });

  it("starts nothing when a run of the workflow is queued and it has no group", async () => {
    const { fireAt, runs } = await due();
    await fireAt(firstFire);

    await fireAt(nextDay);

    expect(await runs()).toHaveLength(1);
  });

  it("starts nothing when a run of another workflow in its group is queued", async () => {
    const otherPath = ".halinka/workflows/other.yml";
    const { fireAt, runs, api, repo } = await due({ [nightlyPath]: grouped, [otherPath]: grouped });
    await api.runs.create({ repoId: repo.id, workflow: otherPath });

    await fireAt(nextDay);

    expect(await runs()).toHaveLength(1);
  });

  it("starts a run when a run of another workflow with no group is queued", async () => {
    const otherPath = ".halinka/workflows/other.yml";
    const { fireAt, runs, api, repo } = await due({
      [nightlyPath]: daily,
      [otherPath]: noSchedule,
    });
    await api.runs.create({ repoId: repo.id, workflow: otherPath });

    await fireAt(firstFire);

    expect(await runs()).toHaveLength(2);
  });

  it("records the refusal when another run holds the branch", async () => {
    const source = workflowOf("0 6 * * *", ["branch:", "  name: halinka/nightly"]);
    const { fireAt, runs, rows } = await due({ [nightlyPath]: source });
    await fireAt(firstFire);

    await fireAt(nextDay);

    const [run] = await runs();
    expect(await runs()).toHaveLength(1);
    expect(await rows()).toMatchObject([
      { lastResult: `The run ${run!.id} holds the branch of this run.` },
    ]);
  });

  it("starts no run when the read of the tip fails", async () => {
    const { fireAt, runs, gitHub } = await due();
    gitHub.refuseWith = refusedRead();

    await fireAt(firstFire);

    expect(await runs()).toEqual([]);
  });

  it("records the failure when the read of the tip fails", async () => {
    const { fireAt, rows, gitHub } = await due();
    gitHub.refuseWith = refusedRead();

    await fireAt(firstFire);

    expect(await rows()).toMatchObject([{ lastResult: "GitHub answered 503: Down" }]);
  });

  it("gives a time 5 minutes later when the read of the tip fails", async () => {
    const { fireAt, rows, gitHub } = await due();
    gitHub.refuseWith = refusedRead();

    await fireAt(firstFire);

    expect(await rows()).toMatchObject([{ nextFireAt: new Date("2100-01-01T06:05:00Z") }]);
  });

  it("starts the run at the try after the read of the tip works", async () => {
    const { fireAt, runs, rows, gitHub } = await due();
    gitHub.refuseWith = refusedRead();
    await fireAt(firstFire);
    gitHub.refuseWith = undefined;

    await fireAt(new Date("2100-01-01T06:05:00Z"));

    expect(await runs()).toHaveLength(1);
    expect(await rows()).toMatchObject([{ nextFireAt: nextDay }]);
  });

  it("keeps the time of a schedule that a push changed during a failed read of the tip", async () => {
    const { fireAt, rows, repo } = await due();
    const pushed = new Date("2100-01-01T07:00:00Z");
    vi.stubGlobal("fetch", async () => {
      await inTransaction(testDb(), ({ workflowSchedule }) =>
        workflowSchedule.rewrite(
          repo.id,
          [{ path: nightlyPath, schedule: "0 7 * * *", nextFireAt: pushed }],
          [],
        ),
      );
      return refusedRead();
    });

    await fireAt(firstFire);

    expect(await rows()).toMatchObject([{ schedule: "0 7 * * *", nextFireAt: pushed }]);
  });

  it("tries a failed read of the tip again no later than the next time of the schedule", async () => {
    const { fireAt, rows, gitHub } = await due({ [nightlyPath]: workflowOf("* * * * *") });
    gitHub.refuseWith = refusedRead();

    await fireAt(firstFire);

    expect(await rows()).toMatchObject([{ nextFireAt: new Date("2100-01-01T06:01:00Z") }]);
  });

  it("goes on to the other schedules after a failure of one", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fireAt, runs, repo } = await due();
    await inTransaction(testDb(), ({ workflowSchedule }) =>
      workflowSchedule.rewrite(
        repo.id,
        [
          { path: nightlyPath, schedule: "0 6 * * *", nextFireAt: firstFire },
          // `beforeFire` puts it first in the order of the fires.
          {
            path: ".halinka/workflows/bad.yml",
            schedule: "not a schedule",
            nextFireAt: beforeFire,
          },
        ],
        [],
      ),
    );

    await fireAt(firstFire);

    expect(await runs()).toHaveLength(1);
    expect(error).toHaveBeenCalledOnce();
  });
});
