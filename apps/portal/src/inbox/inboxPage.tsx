import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@halinka/ui/components/table";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { api } from "../api";
import { formatDateTime } from "../formatDateTime";
import { Page, PageHeader } from "../page";
import { Panel } from "../panel";
import { PanelEmpty } from "../panelEmpty";
import { QueryFallback } from "../queryFallback";
import { InboxItem } from "./inboxItem";

const InboxList = () => {
  const items = useQuery(api.inbox.list.queryOptions());

  if (items.data === undefined) return <QueryFallback error={items.error} />;
  if (items.data.length === 0) {
    return (
      <Panel title="Inbox" hasHeader={false}>
        <PanelEmpty>No pending items.</PanelEmpty>
      </Panel>
    );
  }

  return (
    <Panel title="Inbox" hasHeader={false}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Run</TableHead>
            <TableHead>Step</TableHead>
            <TableHead>Decision</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.data.map((item) => (
            <TableRow key={item.id} className="align-top">
              <TableCell data-cell="title">
                <Link
                  to="/runs/$workflowRunId"
                  params={{ workflowRunId: item.workflowRunId }}
                  className="text-link hover:underline"
                >
                  #{item.workflowRunId}
                </Link>
                <p className="font-medium">{item.workflowName}</p>
                <p className="text-muted-foreground">{item.repoName}</p>
              </TableCell>
              <TableCell data-cell="meta" data-label="Step" className="font-mono">
                {item.stepId}
              </TableCell>
              <TableCell>
                <InboxItem item={item} />
              </TableCell>
              <TableCell data-cell="meta" data-label="Created">
                {formatDateTime(item.createdAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
};

export const InboxPage = () => (
  <Page>
    <PageHeader title="Inbox" description="The decisions and questions that wait for a person." />
    <InboxList />
  </Page>
);
