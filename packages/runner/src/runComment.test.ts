import type { ClaimedRun } from "@halinka/protocol";
import { leaseOf } from "@halinka/protocol/testing";
import { describe, expect, it, vi } from "vitest";

import { madeUpComment, runComment } from "./runComment";

const lease = leaseOf(1);
const url = "https://github.com/acme/app/pull/7#issuecomment-1";
const github = { owner: "acme", name: "app", token: "made-up" };
const request = { stepRunId: 5, stepId: "report", body: "Looks good" };
const signal = new AbortController().signal;

const setUp = (access: object = { pullRequestNumber: 7, github }, answer: object = { url }) => {
  const plane = {
    readCommentAccess: vi.fn(async () => access as { url: string }),
    storeComment: vi.fn(async () => {}),
  };
  const pusher = { postComment: vi.fn(async () => answer as { url: string }) };
  return { plane, pusher, comment: runComment(pusher, plane, { lease } as ClaimedRun) };
};

describe("runComment", () => {
  it("posts the fenced text", async () => {
    const { comment, pusher } = setUp();

    await expect(comment(request, signal)).resolves.toEqual({ url });

    expect(pusher.postComment.mock.calls[0]).toEqual([
      { pullRequestNumber: 7, github },
      "Halinka run 1, step `report`\n\n```\nLooks good\n```\n",
      signal,
    ]);
  });

  it("stores the posted comment", async () => {
    const { comment, plane } = setUp();

    await comment(request, signal);

    expect(plane.storeComment).toHaveBeenCalledWith(lease, 5, url);
  });

  it("posts nothing when the step run has its comment", async () => {
    const { comment, pusher } = setUp({ url });

    await expect(comment(request, signal)).resolves.toEqual({ url });

    expect(pusher.postComment).not.toHaveBeenCalled();
  });

  it("stores nothing when GitHub refuses", async () => {
    const { comment, plane } = setUp(undefined, { error: "GitHub answered 403" });

    await expect(comment(request, signal)).resolves.toEqual({ error: "GitHub answered 403" });

    expect(plane.storeComment).not.toHaveBeenCalled();
  });

  it("makes up a comment for a test run", async () => {
    await expect(madeUpComment(request)).resolves.toEqual({
      url: "https://dry-run.invalid/comment/5",
    });
  });
});
