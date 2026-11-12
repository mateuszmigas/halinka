import { type ChartConfig, ChartContainer } from "@halinka/ui/components/chart";
import { Link } from "@tanstack/react-router";
import { memo } from "react";
import { Cell, Pie, PieChart } from "recharts";

import { formatCost } from "../formatCost";
import { Panel } from "../panel";
import { PanelBody } from "../panelBody";
import { PanelEmpty } from "../panelEmpty";
import { type CostSlice, costSlicesOf } from "./costSlices";

const colors = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

const noSeries: ChartConfig = {};

export type CostChartProps = { days: number; totals: CostSlice[] };

export const CostChart = memo((props: CostChartProps) => {
  const { days, totals } = props;
  const slices = costSlicesOf(totals, colors.length);

  return (
    <Panel
      title="Cost by repo"
      action={
        <Link to="/costs" className="text-link hover:underline">
          Costs
        </Link>
      }
    >
      {slices.length === 0 ? (
        <PanelEmpty>No cost in the last {days} days.</PanelEmpty>
      ) : (
        <PanelBody>
          <div className="flex items-center gap-4">
            <ChartContainer config={noSeries} className="aspect-square h-28 shrink-0">
              <PieChart>
                <Pie
                  data={slices}
                  dataKey="costUsd"
                  nameKey="name"
                  innerRadius="60%"
                  strokeWidth={2}
                >
                  {slices.map(({ name }, index) => (
                    <Cell key={`${index}:${name}`} fill={colors[index]} stroke="var(--card)" />
                  ))}
                </Pie>
              </PieChart>
            </ChartContainer>
            <ul className="flex min-w-0 flex-1 flex-col gap-1.5">
              {slices.map(({ name, costUsd }, index) => (
                <li key={`${index}:${name}`} className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0"
                    style={{ background: colors[index] }}
                  />
                  <span className="truncate text-muted-foreground">{name}</span>
                  <span className="ml-auto tabular-nums">{formatCost(costUsd)}</span>
                </li>
              ))}
            </ul>
          </div>
        </PanelBody>
      )}
    </Panel>
  );
});
