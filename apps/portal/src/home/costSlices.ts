export type CostSlice = { name: string; costUsd: number };

export const costSlicesOf = (totals: CostSlice[], maxSlices: number) => {
  const withCost = totals.filter(({ costUsd }) => costUsd > 0);
  if (withCost.length <= maxSlices) return withCost;
  const rest = withCost.slice(maxSlices - 1);
  return [
    ...withCost.slice(0, maxSlices - 1),
    { name: "Other repos", costUsd: rest.reduce((sum, { costUsd }) => sum + costUsd, 0) },
  ];
};
