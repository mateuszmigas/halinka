import { describe, expect, it } from "vitest";

import { costSlicesOf } from "./costSlices";

const repos = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ name: `repo${index + 1}`, costUsd: 10 - index }));

describe("costSlicesOf", () => {
  it("shows each repo when the repos fit", () => {
    expect(costSlicesOf(repos(5), 5).map(({ name }) => name)).toEqual([
      "repo1",
      "repo2",
      "repo3",
      "repo4",
      "repo5",
    ]);
  });

  it("adds the repos after the last slice into Other repos", () => {
    expect(costSlicesOf(repos(6), 5).at(-1)).toEqual({ name: "Other repos", costUsd: 6 + 5 });
  });

  it("leaves out the repos with no cost", () => {
    expect(costSlicesOf([{ name: "free", costUsd: 0 }], 5)).toEqual([]);
  });
});
