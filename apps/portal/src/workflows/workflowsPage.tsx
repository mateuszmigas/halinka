import type { ApiOutputs } from "@halinka/server/client";
import { Button } from "@halinka/ui/components/button";
import { Input } from "@halinka/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@halinka/ui/components/table";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { api } from "../api";
import { FieldFrame, SelectField } from "../formFields";
import { Page, PageHeader } from "../page";
import { Panel } from "../panel";
import { PanelEmpty } from "../panelEmpty";
import { QueryFallback } from "../queryFallback";
import { fileName } from "../repos/fileName";
import { WorkflowProblemLink } from "../repos/workflowProblemLink";

const allRepos = "all";

type WorkflowListProps = { repos: ApiOutputs["repos"]["list"] };

const WorkflowList = (props: WorkflowListProps) => {
  const { repos } = props;
  const [search, setSearch] = useState("");
  const [repoId, setRepoId] = useState(allRepos);
  const queries = useQueries({
    queries: repos.map((repo) => api.repos.workflows.queryOptions({ input: { id: repo.id } })),
  });
  const selected = repos.flatMap((repo, index) =>
    repoId === allRepos || String(repo.id) === repoId ? [{ repo, query: queries[index]! }] : [],
  );
  const term = search.trim().toLowerCase();
  const rows = selected
    .flatMap(({ repo, query }) =>
      (query.data?.workflows ?? []).map((workflow) => ({ repo, workflow })),
    )
    .filter(({ workflow }) =>
      `${workflow.name ?? ""}\n${workflow.path}`.toLowerCase().includes(term),
    )
    .sort(
      (a, b) =>
        a.repo.name.localeCompare(b.repo.name) ||
        a.repo.id - b.repo.id ||
        (a.workflow.name ?? fileName(a.workflow.path)).localeCompare(
          b.workflow.name ?? fileName(b.workflow.path),
        ) ||
        a.workflow.path.localeCompare(b.workflow.path),
    );
  const groups = Map.groupBy(rows, ({ repo }) => repo);
  const isLoading = selected.some(({ query }) => query.isPending);
  const failed = selected.filter(({ query }) => query.error !== null);

  return (
    <>
      <div role="search" className="flex flex-wrap items-center gap-2">
        <FieldFrame
          id="workflow-search"
          label="Search workflows"
          isLabelHidden
          issues={[]}
          className="min-w-48 flex-1 sm:max-w-sm"
        >
          {(control) => (
            <Input
              {...control}
              type="search"
              placeholder="Search by name or file"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          )}
        </FieldFrame>
        <SelectField
          id="workflow-repo"
          label="Repo"
          isLabelHidden
          issues={[]}
          value={repoId}
          onChange={setRepoId}
          options={[
            { value: allRepos, label: "All repos" },
            ...repos.map((repo) => ({ value: String(repo.id), label: repo.name })),
          ]}
        />
        <span className="ml-auto text-muted-foreground">
          {rows.length === 1 ? "1 workflow" : `${rows.length} workflows`}
        </span>
      </div>
      {failed.map(({ repo, query }) => (
        <div key={repo.id} role="alert" className="flex flex-wrap items-center gap-2">
          <p className="text-destructive">
            {repo.name}: {query.error?.message}
          </p>
          <Button
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Try again
          </Button>
        </div>
      ))}
      {isLoading && (
        <p role="status" className="text-muted-foreground">
          Loading workflows…
        </p>
      )}
      {(rows.length > 0 || (!isLoading && failed.length === 0)) && (
        <Panel title="Workflows" hasHeader={false}>
          {rows.length === 0 ? (
            <PanelEmpty>
              {term || repoId !== allRepos
                ? "No workflows match these filters."
                : "No workflows in the registered repositories."}
            </PanelEmpty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Workflow</TableHead>
                  <TableHead>File</TableHead>
                </TableRow>
              </TableHeader>
              {[...groups].map(([repo, workflows]) => (
                <TableBody key={repo.id}>
                  <TableRow className="border-t bg-muted/50 hover:bg-muted/50">
                    <TableCell colSpan={2} className="font-semibold">
                      <Link
                        to="/repos/$repoId"
                        params={{ repoId: repo.id }}
                        className="hover:underline"
                      >
                        {repo.name}
                      </Link>
                    </TableCell>
                  </TableRow>
                  {workflows.map(({ workflow }) => (
                    <TableRow key={workflow.path}>
                      <TableCell data-cell="title">
                        <Link
                          to="/repos/$repoId/workflows/$file"
                          params={{ repoId: repo.id, file: fileName(workflow.path) }}
                          className="text-link hover:underline"
                        >
                          {workflow.name ?? fileName(workflow.path)}
                        </Link>
                        <WorkflowProblemLink
                          repoId={repo.id}
                          path={workflow.path}
                          problems={workflow.problems}
                        />
                      </TableCell>
                      <TableCell data-cell="meta" className="font-mono text-muted-foreground">
                        {workflow.path}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              ))}
            </Table>
          )}
        </Panel>
      )}
    </>
  );
};

export const WorkflowsPage = () => {
  const repos = useQuery(api.repos.list.queryOptions());

  return (
    <Page>
      <PageHeader title="Workflows" description="The workflows of all repos." />
      {repos.data === undefined ? (
        <QueryFallback error={repos.error} />
      ) : repos.data.length === 0 ? (
        <p className="text-muted-foreground">
          No repositories.{" "}
          <Link to="/repos" className="text-link hover:underline">
            Register a repository
          </Link>{" "}
          to see its workflows.
        </p>
      ) : (
        <WorkflowList repos={repos.data} />
      )}
    </Page>
  );
};
