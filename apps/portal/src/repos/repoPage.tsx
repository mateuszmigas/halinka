import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@halinka/ui/components/table";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";

import { api } from "../api";
import { DangerZone } from "../dangerZone";
import { FormPopover } from "../formPopover";
import { useIsAdmin } from "../login/useIsAdmin";
import { NotFoundPage } from "../notFoundPage";
import { Page, PageHeader } from "../page";
import { Panel } from "../panel";
import { PanelEmpty } from "../panelEmpty";
import { QueryFallback } from "../queryFallback";
import { DeleteRepoSection } from "./deleteRepoSection";
import { fileName } from "./fileName";
import { NewWorkflowForm } from "./newWorkflowForm";
import { RepoSecrets } from "./repoSecrets";
import { WorkflowProblemLink } from "./workflowProblemLink";

export const RepoPage = () => {
  const { repoId } = useParams({ from: "/repos/$repoId" });
  const isAdmin = useIsAdmin();
  const repos = useQuery(api.repos.list.queryOptions());
  const workflows = useQuery(api.repos.workflows.queryOptions({ input: { id: repoId } }));
  const repo = repos.data?.find(({ id }) => id === repoId);

  if (repo === undefined) {
    return <Page>{repos.data ? <NotFoundPage /> : <QueryFallback error={repos.error} />}</Page>;
  }

  return (
    <Page>
      <PageHeader
        title={repo.name}
        description={<span className="font-mono break-all">{repo.path ?? "GitHub"}</span>}
      />
      {workflows.data && workflows.data.configProblems.length > 0 && (
        <div role="alert" className="text-destructive">
          <p>.halinka/config.yml is not valid:</p>
          <ul>
            {workflows.data.configProblems.map(({ line, column, message }) => (
              <li key={`${line}:${column}:${message}`}>
                Line {line}: {message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {workflows.data === undefined ? (
        <QueryFallback error={workflows.error} />
      ) : (
        <Panel
          title="Workflows"
          count={workflows.data.workflows.length}
          action={
            isAdmin &&
            repo.kind === "local" && (
              <FormPopover
                label="New workflow"
                icon={<PlusIcon />}
                size="sm"
                variant="outline"
                title="New workflow"
              >
                {() => <NewWorkflowForm repoId={repoId} />}
              </FormPopover>
            )
          }
        >
          {workflows.data.workflows.length === 0 ? (
            <PanelEmpty>No workflows in .halinka/workflows/.</PanelEmpty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Workflow</TableHead>
                  <TableHead>File</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workflows.data.workflows.map(({ path, name, problems }) => (
                  <TableRow key={path}>
                    <TableCell data-cell="title">
                      <Link
                        to="/repos/$repoId/workflows/$file"
                        params={{ repoId, file: fileName(path) }}
                        className="text-link hover:underline"
                      >
                        {name ?? fileName(path)}
                      </Link>
                      <WorkflowProblemLink repoId={repoId} path={path} problems={problems} />
                    </TableCell>
                    <TableCell data-cell="meta" className="font-mono text-muted-foreground">
                      {path}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>
      )}
      <RepoSecrets repoId={repoId} />
      {isAdmin && (
        <DangerZone>
          <DeleteRepoSection repoId={repo.id} name={repo.name} />
        </DangerZone>
      )}
    </Page>
  );
};
