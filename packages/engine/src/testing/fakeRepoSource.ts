import { vi } from "vitest";

import type { RepoSource } from "../runDeps";

export class FakeRepoSource implements RepoSource {
  readonly published: string[] = [];
  readonly commentOnPullRequest = vi.fn<RepoSource["commentOnPullRequest"]>(async () => ({
    url: "https://github.com/acme/app/pull/7#issuecomment-1",
  }));
  readonly openPullRequest = vi.fn<RepoSource["openPullRequest"]>(async () => ({
    url: "https://github.com/acme/app/pull/1",
    isCreated: true,
  }));
  private refusedReason: string | undefined;

  refusePublish(message: string) {
    this.refusedReason = message;
  }

  async publish(commit: string) {
    if (this.refusedReason) throw new Error(this.refusedReason);
    this.published.push(commit);
  }
}
