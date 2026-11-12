import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@halinka/ui/components/table";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api";
import { formatCost } from "../formatCost";
import { Page, PageHeader } from "../page";
import { Panel } from "../panel";
import { QueryFallback } from "../queryFallback";
import { type CostTotal, costTotals, repoOwnerOf } from "./costTotals";

type CostTableProps = {
  title: string;
  totals: CostTotal[];
};

const CostTable = (props: CostTableProps) => {
  const { title, totals } = props;

  return (
    <Panel title={title}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Cost</TableHead>
            <TableHead>Attempts with no cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {totals.map(({ id, name, costUsd, attemptsWithNoCost }) => (
            <TableRow key={id ?? "none"}>
              <TableCell data-cell="title">{name}</TableCell>
              <TableCell data-cell="meta" data-label="Cost">
                {formatCost(costUsd)}
              </TableCell>
              <TableCell data-cell="meta" data-label="Attempts with no cost">
                {attemptsWithNoCost}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
};

export const CostsPage = () => {
  const costs = useQuery(api.costs.list.queryOptions());
  const { data: session } = useQuery(api.session.queryOptions());

  if (costs.data === undefined) {
    return (
      <Page>
        <PageHeader title="Costs" />
        <QueryFallback error={costs.error} />
      </Page>
    );
  }
  const { days, totals } = costs.data;
  const hasTotals = totals.length > 0;

  return (
    <Page>
      <PageHeader
        title="Costs"
        description={
          hasTotals
            ? `The last ${days} days. An attempt with no cost is an attempt of an agent that reported none, so the real cost can be higher. A deleted run is not counted.`
            : `No agent attempts in the last ${days} days.`
        }
      />
      {hasTotals && <CostTable title="By repo" totals={costTotals(totals, repoOwnerOf)} />}
      {hasTotals && session?.isLoginRequired && (
        <CostTable
          title="By person"
          totals={costTotals(totals, ({ authorId, authorLogin }) => ({
            id: authorId,
            name: authorLogin ?? "No person",
          }))}
        />
      )}
    </Page>
  );
};
