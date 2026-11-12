type CostRow = { costUsd: number; attemptsWithNoCost: number };

export type CostTotal = CostRow & { id: number | undefined; name: string };

export const repoOwnerOf = ({ repoId, repoName }: { repoId: number; repoName: string }) => ({
  id: repoId,
  name: repoName,
});

// By id: a repo name is not unique, and a login can pass to another person.
export const costTotals = <T extends CostRow>(
  rows: T[],
  ownerOf: (row: T) => { id: number | undefined; name: string },
) => {
  const totals = new Map<number | undefined, CostTotal>();
  for (const row of rows) {
    const { id, name } = ownerOf(row);
    const total = totals.get(id) ?? { id, name, costUsd: 0, attemptsWithNoCost: 0 };
    total.costUsd += row.costUsd;
    total.attemptsWithNoCost += row.attemptsWithNoCost;
    totals.set(id, total);
  }
  return [...totals.values()].sort((first, second) => second.costUsd - first.costUsd);
};
