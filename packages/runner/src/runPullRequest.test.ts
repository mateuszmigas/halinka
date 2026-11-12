import type { ClaimedRun, PullRequestAnswer, PullRequestOpen } from "@halinka/protocol";
import { leaseOf } from "@halinka/protocol/testing";
import { describe, expect, it, vi } from "vitest";

import { madeUpPullRequest, runPullRequest } from "./runPullRequest";

const lease = leaseOf(1);
const commit = "a".repeat(40);
const pushedCommit = "b".repeat(40);
const url = "https://github.com/acme/app/pull/7";
const github = { owner: "acme", name: "app", token: "made-up" };

const setUp = ({
  place = { repoPath: "/repo" } as { repoPath: string } | { githubRepoId: number },
  answer = { url, isCreated: true } as PullRequestAnswer,
} = {}) => {
  const run = { ...place, lease, branch: "fix/1", baseSha: "c".repeat(40) } as ClaimedRun;
  const opened: PullRequestOpen[] = [];
  const plane = {
    readPushAccess: vi.fn(async () => ({ commit, github, pushedCommit })),
    storePushedBranch: vi.fn(async () => {}),
  };
  const pusher = {
    openPullRequestInRun: async (
      input: PullRequestOpen,
      _signal: AbortSignal,
      onPushed: () => Promise<void>,
    ) => {
      opened.push(input);
      await onPushed();
      return answer;
    },
  };
  const open = () =>
    runPullRequest(
      pusher,
      plane,
      run,
    )({ stepRunId: 5, title: "Title", body: "Body" }, new AbortController().signal);
  return { plane, opened, open };
};

describe("runPullRequest", () => {
  it("asks for the access of the running step", async () => {
    const { plane, open } = setUp();

    await open();

    expect(plane.readPushAccess).toHaveBeenCalledWith(lease, 5);
  });

  it("gives the checkout of a local repo to the pusher", async () => {
    const { opened, open } = setUp();

    await open();

    expect(opened[0]).toEqual({
      repoPath: "/repo",
      workflowRunId: 1,
      branch: "fix/1",
      baseSha: "c".repeat(40),
      commit,
      pushedCommit,
      github,
      title: "Title",
      body: "Body",
    });
  });

  it("gives the id of a GitHub repo to the pusher, with no path", async () => {
    const { opened, open } = setUp({ place: { githubRepoId: 100 } });

    await open();

    expect(opened[0]).toMatchObject({ githubRepoId: 100 });
    expect(opened[0]).not.toHaveProperty("repoPath");
  });

  it("stores the push over the lease, then the URL over the push", async () => {
    const { plane, open } = setUp();

    await open();

    expect(plane.storePushedBranch.mock.calls).toEqual([
      [lease, 5, { expected: pushedCommit }],
      [lease, 5, { expected: commit, pullRequestUrl: url }],
    ]);
  });

  it("stores only the push after a pull request error", async () => {
    const { plane, open } = setUp({ answer: { error: "Refused" } });

    await open();

    expect(plane.storePushedBranch.mock.calls).toEqual([[lease, 5, { expected: pushedCommit }]]);
  });

  it("gives the answer of the pusher", async () => {
    const { open } = setUp({ answer: { error: "Refused" } });

    expect(await open()).toEqual({ error: "Refused" });
  });

  it("makes up a pull request URL that no browser can open", async () => {
    const answer = await madeUpPullRequest({ stepRunId: 5, title: "Title", body: "Body" });

    expect(answer).toEqual({ url: "https://dry-run.invalid/pull/5", isCreated: true });
  });
});
