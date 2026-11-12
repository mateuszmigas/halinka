import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@halinka/ui/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@halinka/ui/components/tabs";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";

import { api } from "../api";
import { FormPopover } from "../formPopover";
import { useIsAdmin } from "../login/useIsAdmin";
import { Page, PageHeader } from "../page";
import { Panel } from "../panel";
import { PanelEmpty } from "../panelEmpty";
import { QueryFallback } from "../queryFallback";
import { AddGitHubRepoForm } from "./addGitHubRepoForm";
import { RegisterRepoForm } from "./registerRepoForm";

const RepoList = () => {
  const repos = useQuery(api.repos.list.queryOptions());

  if (repos.data === undefined) return <QueryFallback error={repos.error} />;
  if (repos.data.length === 0) {
    return (
      <Panel title="Repos" hasHeader={false}>
        <PanelEmpty>
          No repos. Add one with Add repo, or run <code className="font-mono">halinka init</code> in
          a git repo.
        </PanelEmpty>
      </Panel>
    );
  }

  return (
    <Panel title="Repos" hasHeader={false}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Path</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {repos.data.map((repo) => (
            <TableRow key={repo.id}>
              <TableCell data-cell="title">
                <Link
                  to="/repos/$repoId"
                  params={{ repoId: repo.id }}
                  className="text-link hover:underline"
                >
                  {repo.name}
                </Link>
              </TableCell>
              <TableCell data-cell="meta" className="font-mono text-muted-foreground">
                {repo.path ?? "GitHub"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
};

const AddRepoPopover = () => (
  <FormPopover label="Add repo" icon={<PlusIcon />} title="Add repo" width="lg">
    {(close) => (
      <Tabs defaultValue="local">
        <TabsList>
          <TabsTrigger value="local">A folder on a runner</TabsTrigger>
          <TabsTrigger value="github">GitHub</TabsTrigger>
        </TabsList>
        <TabsContent value="local">
          <RegisterRepoForm onRegistered={close} />
        </TabsContent>
        <TabsContent value="github">
          <AddGitHubRepoForm onAdded={close} />
        </TabsContent>
      </Tabs>
    )}
  </FormPopover>
);

export const ReposPage = () => {
  const isAdmin = useIsAdmin();

  return (
    <Page>
      <PageHeader
        title="Repos"
        description="The repos that runs get code and workflows from."
        actions={isAdmin && <AddRepoPopover />}
      />
      <RepoList />
    </Page>
  );
};
