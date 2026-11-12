import type { ApiOutputs } from "@halinka/server/client";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@halinka/ui/components/chart";
import { memo } from "react";
import { Bar, BarChart, XAxis } from "recharts";

import { Panel } from "../panel";
import { PanelBody } from "../panelBody";

const config = {
  succeeded: { label: "Succeeded", color: "var(--success)" },
  failed: { label: "Failed", color: "var(--destructive)" },
  other: { label: "Other", color: "var(--muted-foreground)" },
} satisfies ChartConfig;

const dayFormat = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

const dayLabel = (day: unknown) => dayFormat.format(new Date(`${String(day)}T00:00:00Z`));

const tooltip = <ChartTooltipContent labelFormatter={dayLabel} />;

const legend = <ChartLegendContent />;

export type RunsChartProps = { perDay: ApiOutputs["runs"]["totals"]["perDay"] };

export const RunsChart = memo((props: RunsChartProps) => {
  const { perDay } = props;

  return (
    <Panel title={`Runs per day, last ${perDay.length} days`}>
      <PanelBody>
        <ChartContainer config={config} className="aspect-auto h-52 w-full">
          <BarChart data={perDay} margin={{ left: 0, right: 0, top: 4 }}>
            <XAxis
              dataKey="day"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
              tickFormatter={dayLabel}
            />
            <ChartTooltip content={tooltip} />
            <Bar dataKey="succeeded" stackId="runs" fill="var(--color-succeeded)" />
            <Bar dataKey="failed" stackId="runs" fill="var(--color-failed)" />
            <Bar dataKey="other" stackId="runs" fill="var(--color-other)" />
            <ChartLegend content={legend} />
          </BarChart>
        </ChartContainer>
      </PanelBody>
    </Panel>
  );
});
