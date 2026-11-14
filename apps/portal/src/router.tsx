import {
  createRootRoute,
  createRoute,
  createRouter,
  notFound,
  redirect,
} from "@tanstack/react-router";

import { AgentsPage } from "./agents/agentsPage";
import { CostsPage } from "./costs/costsPage";
import { GitHubCreatedPage } from "./github/githubCreatedPage";
import { GitHubPage } from "./github/githubPage";
import { HomePage } from "./home/homePage";
import { InboxPage } from "./inbox/inboxPage";
import { Layout } from "./layout";
import { CliLoginPage } from "./login/cliLoginPage";
import { TerminalsPage } from "./login/terminalsPage";
import { MembersPage } from "./members/membersPage";
import { NotFoundPage } from "./notFoundPage";
import { parseLineSearch } from "./repos/lineSearch";
import { RepoPage } from "./repos/repoPage";
import { ReposPage } from "./repos/reposPage";
import { WorkflowPage } from "./repos/workflowPage";
import { RunnersPage } from "./runners/runnersPage";
import { RunPage } from "./runs/runPage";
import { RunsPage } from "./runs/runsPage";
import { ServerSettingsPage } from "./serverSettings/serverSettingsPage";
import { WorkflowsPage } from "./workflows/workflowsPage";

const rootRoute = createRootRoute({ component: Layout });

// An id that is not a positive integer gives the not-found page.
const idParam = <Name extends string, StringName extends string = never>(name: Name) => ({
  params: {
    parse: (params: Record<Name | StringName, string>) => {
      const value = params[name];
      const id = /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
      return { ...params, [name]: id } as Record<StringName, string> & Record<Name, number>;
    },
    stringify: (params: Record<StringName, string> & Record<Name, number>) =>
      ({ ...params, [name]: String(params[name]) }) as Record<Name | StringName, string>,
  },
  remountDeps: ({ params }: { params: unknown }) => params,
  beforeLoad: ({ params }: { params: Record<Name, number> }) => {
    if (!Number.isSafeInteger(params[name])) throw notFound();
  },
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});

const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs",
  component: RunsPage,
});

const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$workflowRunId",
  staticData: { crumbs: [{ label: "Runs", path: "/runs" }] },
  ...idParam("workflowRunId"),
  validateSearch: (search: Record<string, unknown>): { pane?: "step" } =>
    search.pane === "step" ? { pane: "step" } : {},
  component: RunPage,
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  component: InboxPage,
});

const costsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/costs",
  component: CostsPage,
});

const reposRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/repos",
  component: ReposPage,
});

const cliLoginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cli-login",
  validateSearch: (search: Record<string, unknown>): { code?: string } =>
    typeof search.code === "string" && search.code ? { code: search.code } : {},
  component: CliLoginPage,
});

const terminalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/terminals",
  component: TerminalsPage,
});

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents",
  component: AgentsPage,
});

const membersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/members",
  component: MembersPage,
});

const serverSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/server",
  component: ServerSettingsPage,
});

const gitHubRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/github",
  validateSearch: (search: Record<string, unknown>): { installation_id?: unknown } =>
    search.installation_id ? { installation_id: search.installation_id } : {},
  component: GitHubPage,
});

const gitHubCreatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/github/created",
  staticData: { crumbs: [{ label: "GitHub", path: "/github" }] },
  validateSearch: (search: Record<string, unknown>): { code?: string; state?: string } => ({
    ...(typeof search.code === "string" && { code: search.code }),
    ...(typeof search.state === "string" && { state: search.state }),
  }),
  component: GitHubCreatedPage,
});

const runnersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runners",
  validateSearch: (search: Record<string, unknown>): { approve?: string } =>
    typeof search.approve === "string" ? { approve: search.approve } : {},
  component: RunnersPage,
});

const approveRunnerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runners/approve",
  validateSearch: (search: Record<string, unknown>): { code?: string } =>
    typeof search.code === "string" && search.code ? { code: search.code } : {},
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/runners", search: { approve: search.code ?? "" } });
  },
});

const workflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflows",
  component: WorkflowsPage,
});

const repoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/repos/$repoId",
  staticData: { crumbs: [{ label: "Repos", path: "/repos" }] },
  ...idParam("repoId"),
  component: RepoPage,
});

const workflowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/repos/$repoId/workflows/$file",
  staticData: { crumbs: [{ label: "Repos", path: "/repos" }] },
  ...idParam<"repoId", "file">("repoId"),
  validateSearch: parseLineSearch,
  component: WorkflowPage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    runsRoute,
    runRoute,
    inboxRoute,
    workflowsRoute,
    reposRoute,
    repoRoute,
    workflowRoute,
    runnersRoute,
    approveRunnerRoute,
    agentsRoute,
    costsRoute,
    membersRoute,
    gitHubRoute,
    gitHubCreatedRoute,
    serverSettingsRoute,
    cliLoginRoute,
    terminalsRoute,
  ]),
  defaultNotFoundComponent: NotFoundPage,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
