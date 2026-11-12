import type { ApiOutputs } from "@halinka/server/client";
import { Button } from "@halinka/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@halinka/ui/components/table";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { RotateCcwIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

import { api } from "../api";
import { ErrorText } from "../errorText";
import { formatDateTime } from "../formatDateTime";
import { Page, PageHeader } from "../page";
import { Panel } from "../panel";
import { PanelBody } from "../panelBody";
import { PanelEmpty } from "../panelEmpty";
import { QueryFallback } from "../queryFallback";
import { ScrollContainerContext } from "../scrollContainer";
import { statusPollMs } from "../statusPollMs";
import { NewRunPopover } from "./newRunPopover";
import { StatusLabel } from "./statusLabel";

const estimatedRowPx = 49;

type Run = ApiOutputs["runs"]["list"]["runs"][number];

const useVirtualizeRows = (keys: number[], onReachEnd: () => void) => {
  const count = keys.length;
  const scrollContainer = useContext(ScrollContainerContext);
  const [body, setBody] = useState<HTMLTableSectionElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  // oxlint-disable-next-line react/incompatible-library -- the portal has no React Compiler
  const virtualizer = useVirtualizer({
    count,
    getItemKey: (index) => keys[index]!,
    getScrollElement: () => scrollContainer,
    estimateSize: () => estimatedRowPx,
    overscan: 10,
    scrollMargin,
  });

  useLayoutEffect(() => {
    if (!body || !scrollContainer) return;
    const top = body.getBoundingClientRect().top;
    const containerTop = scrollContainer.getBoundingClientRect().top;
    setScrollMargin(top - containerTop + scrollContainer.scrollTop);
  }, [body, scrollContainer]);

  const items = virtualizer.getVirtualItems();
  const lastIndex = items.at(-1)?.index ?? -1;

  useEffect(() => {
    if (lastIndex >= count - 1) onReachEnd();
  }, [lastIndex, count, onReachEnd]);

  return {
    setBody,
    items,
    measure: virtualizer.measureElement,
    paddingTop: (items[0]?.start ?? scrollMargin) - scrollMargin,
    paddingBottom: virtualizer.getTotalSize() - (items.at(-1)?.end ?? scrollMargin) + scrollMargin,
  };
};

type RunRowProps = { run: Run; index: number; measure: (row: HTMLTableRowElement | null) => void };

const RunRow = memo((props: RunRowProps) => {
  const { run, index, measure } = props;

  return (
    <TableRow data-index={index} ref={measure}>
      <TableCell data-cell="title">
        <Link
          to="/runs/$workflowRunId"
          params={{ workflowRunId: run.id }}
          className="text-link hover:underline"
        >
          #{run.id}
        </Link>
      </TableCell>
      <TableCell>
        <p className="font-medium">{run.workflowName}</p>
        <p className="text-muted-foreground">{run.workflowPath}</p>
      </TableCell>
      <TableCell data-cell="meta" data-label="Repo">
        {run.repoName}
      </TableCell>
      <TableCell data-cell="status">
        <StatusLabel status={run.status} />
      </TableCell>
      <TableCell data-cell="meta" data-label="Branch" className="font-mono text-muted-foreground">
        {run.branch}
      </TableCell>
      <TableCell data-cell="meta" data-label="Created">
        {formatDateTime(run.createdAt)}
      </TableCell>
    </TableRow>
  );
});

const RunList = () => {
  const pages = useInfiniteQuery({
    ...api.runs.list.infiniteOptions({
      input: (beforeId: number | undefined) => ({ beforeId }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextBeforeId,
    }),
    // A poll refetches every loaded page, so poll only while one page is loaded.
    refetchInterval: (query) => ((query.state.data?.pages.length ?? 0) > 1 ? false : statusPollMs),
  });
  const runs = useMemo(() => pages.data?.pages.flatMap((page) => page.runs) ?? [], [pages.data]);
  const runIds = useMemo(() => runs.map(({ id }) => id), [runs]);
  const { hasNextPage, isFetching, isFetchingNextPage, isFetchNextPageError, fetchNextPage } =
    pages;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetching && !isFetchNextPageError) void fetchNextPage();
  }, [hasNextPage, isFetching, isFetchNextPageError, fetchNextPage]);
  const { setBody, items, measure, paddingTop, paddingBottom } = useVirtualizeRows(
    runIds,
    loadMore,
  );

  if (pages.data === undefined) return <QueryFallback error={pages.error} />;
  if (runs.length === 0) {
    return (
      <Panel title="Runs" hasHeader={false}>
        <PanelEmpty>No runs.</PanelEmpty>
      </Panel>
    );
  }

  return (
    <Panel title="Runs" hasHeader={false}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Run</TableHead>
            <TableHead>Workflow</TableHead>
            <TableHead>Repo</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Branch</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody ref={setBody}>
          {paddingTop > 0 && <tr aria-hidden style={{ height: paddingTop }} />}
          {items.map(({ index, key }) => (
            <RunRow key={key} run={runs[index]!} index={index} measure={measure} />
          ))}
          {paddingBottom > 0 && <tr aria-hidden style={{ height: paddingBottom }} />}
        </TableBody>
      </Table>
      {isFetchingNextPage && <PanelEmpty>Loading more runs…</PanelEmpty>}
      {isFetchNextPageError && (
        <PanelBody>
          <ErrorText error={pages.error} />
          <div>
            <Button variant="outline" onClick={() => void fetchNextPage()}>
              <RotateCcwIcon />
              Try again
            </Button>
          </div>
        </PanelBody>
      )}
    </Panel>
  );
};

export const RunsPage = () => (
  <Page>
    <PageHeader
      title="Runs"
      description="Start a run, and see all runs."
      actions={<NewRunPopover />}
    />
    <RunList />
  </Page>
);
