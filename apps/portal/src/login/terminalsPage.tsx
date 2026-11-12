import type { ApiOutputs } from "@halinka/server/client";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@halinka/ui/components/table";
import { useMutation, useQuery } from "@tanstack/react-query";

import { api } from "../api";
import { formatDateTime } from "../formatDateTime";
import { Page, PageHeader } from "../page";
import { Panel } from "../panel";
import { PanelEmpty } from "../panelEmpty";
import { QueryFallback } from "../queryFallback";
import { RowMenu } from "../rowMenu";
import { useInvalidateQueries } from "../useInvalidateQueries";

type Terminal = ApiOutputs["cliLogin"]["list"][number];

type TerminalMenuProps = { terminal: Terminal };

const TerminalMenu = (props: TerminalMenuProps) => {
  const { terminal } = props;
  const refreshLogins = useInvalidateQueries(api.cliLogin.list.key());
  const end = useMutation(api.cliLogin.end.mutationOptions({ onSuccess: refreshLogins }));

  return (
    <RowMenu
      name={`the login of ${formatDateTime(terminal.createdAt)}`}
      items={[
        {
          label: "End",
          confirm: {
            title: "End this login?",
            description: "That terminal must run halinka login again.",
            keepLabel: "Keep",
          },
          onSelect: () => end.mutate({ id: terminal.id }),
        },
      ]}
      isPending={end.isPending}
      error={end.error}
    />
  );
};

export const TerminalsPage = () => {
  const terminals = useQuery(api.cliLogin.list.queryOptions());

  return (
    <Page>
      <PageHeader title="Terminals" description="The terminals that use your login." />
      {terminals.data === undefined ? (
        <QueryFallback error={terminals.error} />
      ) : terminals.data.length === 0 ? (
        <Panel title="Terminals" hasHeader={false}>
          <PanelEmpty>No terminal is logged in as you.</PanelEmpty>
        </Panel>
      ) : (
        <Panel title="Terminals" hasHeader={false}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Logged in</TableHead>
                <TableHead>Ends</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {terminals.data.map((terminal) => (
                <TableRow key={terminal.id}>
                  <TableCell data-cell="title" data-label="Logged in">
                    {formatDateTime(terminal.createdAt)}
                  </TableCell>
                  <TableCell data-cell="meta" data-label="Ends">
                    {formatDateTime(terminal.expiresAt)}
                  </TableCell>
                  <TableCell data-cell="menu">
                    <TerminalMenu terminal={terminal} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}
    </Page>
  );
};
