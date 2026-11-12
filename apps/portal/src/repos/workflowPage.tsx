import { useQuery } from "@tanstack/react-query";
import { useParams, useSearch } from "@tanstack/react-router";

import { api } from "../api";
import { PageHeader } from "../page";
import { QueryFallback } from "../queryFallback";
import { WorkflowEditor } from "./workflowEditor";

export const WorkflowPage = () => {
  const { repoId, file } = useParams({ from: "/repos/$repoId/workflows/$file" });
  const { line } = useSearch({ from: "/repos/$repoId/workflows/$file" });
  const query = useQuery(
    api.repos.workflow.queryOptions({ input: { id: repoId, workflow: file } }),
  );

  const repos = useQuery(api.repos.list.queryOptions());
  const repo = repos.data?.find(({ id }) => id === repoId);

  if (query.data === undefined) return <QueryFallback error={query.error} />;
  if (repo === undefined) return <QueryFallback error={repos.error} />;

  const { path, source, hash, workflow } = query.data;

  return (
    <div className="flex min-h-full flex-col gap-6">
      <PageHeader
        title={workflow?.name ?? file}
        description={path}
        parentCrumbs={[{ label: repo.name, path: `/repos/${repoId}` }]}
      />
      <WorkflowEditor
        key={`${repoId}:${path}`}
        repoId={repoId}
        path={path}
        source={source}
        hash={hash}
        isOnGitHub={repo.kind !== "local"}
        revealLine={line}
      />
    </div>
  );
};
