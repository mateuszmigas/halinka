import { describe, expect, it } from "vitest";

import { costTotals } from "./costTotals";

type RowOptions = { costUsd: number; attemptsWithNoCost?: number };

const row = (id: number, name: string, { costUsd, attemptsWithNoCost = 0 }: RowOptions) => ({
  id,
  name,
  costUsd,
  attemptsWithNoCost,
});

const ownerOf = ({ id, name }: { id: number; name: string }) => ({ id, name });

describe("costTotals", () => {
  it("adds the rows of one owner", () => {
    const totals = costTotals(
      [
        row(1, "app", { costUsd: 1, attemptsWithNoCost: 2 }),
        row(1, "app", { costUsd: 0.5, attemptsWithNoCost: 1 }),
      ],
      ownerOf,
    );

    expect(totals).toEqual([{ id: 1, name: "app", costUsd: 1.5, attemptsWithNoCost: 3 }]);
  });

  it("keeps two owners with one name apart", () => {
    const totals = costTotals(
      [row(1, "app", { costUsd: 1 }), row(2, "app", { costUsd: 2 })],
      ownerOf,
    );

    expect(totals.map(({ id }) => id)).toEqual([2, 1]);
  });

  it("puts the highest cost first", () => {
    const totals = costTotals(
      [row(1, "app", { costUsd: 1 }), row(2, "web", { costUsd: 3 })],
      ownerOf,
    );

    expect(totals.map(({ name }) => name)).toEqual(["web", "app"]);
  });
});
