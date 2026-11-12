import type { ApiOutputs } from "@halinka/server/client";
import { Badge } from "@halinka/ui/components/badge";
import { Button, buttonVariants } from "@halinka/ui/components/button";
import { Input } from "@halinka/ui/components/input";
import { RadioGroup, RadioGroupItem } from "@halinka/ui/components/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@halinka/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@halinka/ui/components/table";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { RefreshCwIcon, UnplugIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ActionButton } from "../actionButton";
import { api } from "../api";
import { DangerZone } from "../dangerZone";
import { ErrorText } from "../errorText";
import { toFormErrors } from "../formErrors";
import { FieldFrame } from "../formFields";
import { FormShell } from "../formShell";
import { GitHubMark } from "../gitHubMark";
import { Page, PageHeader } from "../page";
import { Panel } from "../panel";
import { PanelRow } from "../panelRow";
import { QueryFallback } from "../queryFallback";
import { useInvalidateQueries } from "../useInvalidateQueries";
import { useSubmitMutation } from "../useSubmitMutation";
import { SetupStep, type SetupStepState } from "./setupStep";

type GitHubStatus = ApiOutputs["github"]["status"];

type GitHubApp = NonNullable<GitHubStatus["app"]>;

// GitHub accepts a manifest only from a form post.
const postManifest = ({ url, manifest }: ApiOutputs["github"]["manifest"]) => {
  const form = document.createElement("form");
  form.method = "post";
  form.action = url;
  const field = document.createElement("input");
  field.type = "hidden";
  field.name = "manifest";
  field.value = manifest;
  form.append(field);
  document.body.append(form);
  form.submit();
};

type Owner = "user" | "organization";

const ownerOptions: { value: Owner; label: string; description: string }[] = [
  {
    value: "user",
    label: "My GitHub user",
    description: "Runs can use only the repos of your user.",
  },
  {
    value: "organization",
    label: "An organization",
    description: "Runs can use the repos of the organization. You must be an owner of it.",
  },
];

const CreateAppForm = () => {
  const [owner, setOwner] = useState<Owner>("user");
  const createManifest = useSubmitMutation(api.github.manifest.mutationOptions());
  const form = useForm({
    defaultValues: { organization: "" },
    validators: {
      onSubmitAsync: async ({ value }) => {
        const organization = owner === "organization" ? value.organization.trim() : "";
        if (owner === "organization" && !organization) {
          return { fields: { organization: [{ message: "Enter the name of the organization." }] } };
        }
        const { data, error } = await createManifest(organization ? { organization } : {});
        if (error) return toFormErrors(error, ["organization"]);
        postManifest(data);
        return undefined;
      },
    },
  });

  return (
    <FormShell form={form}>
      <fieldset className="flex flex-col gap-2">
        <legend id="app-owner" className="mb-2 font-medium">
          Who owns the App?
        </legend>
        <RadioGroup
          aria-labelledby="app-owner"
          value={owner}
          onValueChange={(value) => setOwner(value as Owner)}
          className="grid gap-2 sm:grid-cols-2"
        >
          {ownerOptions.map(({ value, label, description }) => (
            <label
              key={value}
              htmlFor={`owner-${value}`}
              className="flex cursor-pointer items-start gap-3 border p-3 has-data-checked:border-link"
            >
              <RadioGroupItem id={`owner-${value}`} value={value} className="mt-0.5" />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{label}</span>
                <span className="text-muted-foreground">{description}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
      </fieldset>
      {owner === "organization" && (
        <form.Field name="organization">
          {(field) => (
            <FieldFrame
              id={field.name}
              label="Organization name"
              description="The name in the URL of the organization: github.com/acme"
              issues={field.state.meta.errors}
            >
              {(control) => (
                <Input
                  {...control}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="acme"
                  className="max-w-sm font-mono"
                />
              )}
            </FieldFrame>
          )}
        </form.Field>
      )}
      <div>
        <Button type="submit">
          <GitHubMark />
          Create the App on GitHub
        </Button>
      </div>
    </FormShell>
  );
};

type AppSummaryProps = { app: GitHubApp };

const AppSummary = (props: AppSummaryProps) => {
  const { app } = props;

  return (
    <div className="flex flex-col gap-1">
      <p>
        The App <span className="font-mono">{app.slug}</span> of {app.ownerLogin}.
      </p>
      {!app.isReadable && (
        <p className="text-destructive">
          Halinka cannot read the key of the App: the master key changed. Disconnect the App, then
          create a new one.
        </p>
      )}
    </div>
  );
};

type InstallActionsProps = {
  app: GitHubApp;
  isInstalled: boolean;
  isRefreshing: boolean;
  onRefresh: () => void;
};

const InstallActions = (props: InstallActionsProps) => {
  const { app, isInstalled, isRefreshing, onRefresh } = props;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <a
        href={app.installUrl}
        className={buttonVariants({ variant: isInstalled ? "outline" : "default" })}
      >
        <GitHubMark />
        {isInstalled ? "Select repos on GitHub" : "Install the App on GitHub"}
      </a>
      <Button variant="outline" disabled={isRefreshing} onClick={onRefresh}>
        <RefreshCwIcon />
        Refresh
      </Button>
    </div>
  );
};

const disconnectDescription =
  "Halinka removes the key of the App and its list of repos. The App stays on GitHub, so delete it there too.";

type DisconnectAppProps = { app: GitHubApp };

const DisconnectApp = (props: DisconnectAppProps) => {
  const { app } = props;
  const refreshStatus = useInvalidateQueries(api.github.status.key());
  const disconnect = useMutation(
    api.github.disconnect.mutationOptions({ onSuccess: refreshStatus }),
  );

  return (
    <PanelRow title="Disconnect the App" description={disconnectDescription}>
      <ActionButton
        label="Disconnect"
        icon={<UnplugIcon />}
        confirm={{
          title: `Disconnect ${app.slug}?`,
          description: disconnectDescription,
          keepLabel: "Keep",
        }}
        isPending={disconnect.isPending}
        error={disconnect.error}
        onClick={() => disconnect.mutate()}
      />
    </PanelRow>
  );
};

type InstallationsProps = { installations: GitHubStatus["installations"] };

const Installations = (props: InstallationsProps) => {
  const { installations } = props;

  if (installations.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {installations.map(({ githubId, accountLogin, isSuspended, repos }) => (
        <li key={githubId}>
          <span className="font-medium">{accountLogin}</span>
          {isSuspended && " (suspended)"}
          <span className="text-muted-foreground">
            {" "}
            · {repos.length === 1 ? "1 repo" : `${repos.length} repos`}:{" "}
            {repos.map(({ owner, name }) => `${owner}/${name}`).join(", ")}
          </span>
        </li>
      ))}
    </ul>
  );
};

const noLink = "none";

type RepoLinksProps = { githubRepos: GitHubStatus["installations"][number]["repos"] };

const RepoLinks = (props: RepoLinksProps) => {
  const { githubRepos } = props;
  const refreshRepos = useInvalidateQueries(api.repos.list.key());
  const repos = useQuery(api.repos.list.queryOptions());
  const link = useMutation(api.repos.linkGitHub.mutationOptions({ onSuccess: refreshRepos }));

  if (!repos.data) return <QueryFallback error={repos.error} />;
  const localRepos = repos.data.filter(({ kind }) => kind === "local");
  return (
    <div className="flex flex-col gap-2">
      <ErrorText error={link.error} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Repo</TableHead>
            <TableHead>GitHub repo</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {localRepos.map(({ id, path, githubRepoId }) => (
            <TableRow key={id}>
              <TableCell data-cell="title" className="font-mono">
                {path}
              </TableCell>
              <TableCell>
                <Select
                  value={githubRepoId === undefined ? noLink : String(githubRepoId)}
                  disabled={link.isPending}
                  onValueChange={(value) =>
                    link.mutate({ id, githubRepoId: value === noLink ? null : Number(value) })
                  }
                >
                  <SelectTrigger aria-label={`GitHub repo of ${path}`} className="min-w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={noLink}>No link</SelectItem>
                    {githubRepoId !== undefined &&
                      !githubRepos.some(({ githubId }) => githubId === githubRepoId) && (
                        <SelectItem value={String(githubRepoId)}>No access for the App</SelectItem>
                      )}
                    {githubRepos.map(({ githubId, owner, name }) => (
                      <SelectItem key={githubId} value={String(githubId)}>
                        {owner}/{name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};

export const GitHubPage = () => {
  const { installation_id: returnedFromInstall } = useSearch({ from: "/github" });
  const navigate = useNavigate();
  const refreshStatus = useInvalidateQueries(api.github.status.key());
  const status = useQuery(api.github.status.queryOptions());
  const repos = useQuery(api.repos.list.queryOptions());
  const refresh = useMutation(api.github.refresh.mutationOptions({ onSuccess: refreshStatus }));
  const { mutate: refreshNow } = refresh;

  useEffect(() => {
    if (!returnedFromInstall) return;
    refreshNow();
    void navigate({ to: "/github", search: {}, replace: true });
  }, [returnedFromInstall, navigate, refreshNow]);

  if (status.data === undefined) {
    return (
      <Page>
        <PageHeader title="GitHub" />
        <QueryFallback error={status.error} />
      </Page>
    );
  }

  const { app, installations } = status.data;
  const isInstalled = installations.length > 0;
  const githubRepos = installations.flatMap(({ repos }) => repos);
  const isLinked =
    repos.data?.some(({ kind, githubRepoId }) => kind === "local" && githubRepoId !== undefined) ??
    false;
  const createState: SetupStepState = app ? "done" : "current";
  const installState: SetupStepState = !app ? "waiting" : isInstalled ? "done" : "current";
  const linkState: SetupStepState = !app
    ? "waiting"
    : isLinked
      ? "done"
      : isInstalled
        ? "current"
        : "waiting";
  const currentStep = [createState, installState, linkState].indexOf("current") + 1;

  return (
    <Page>
      <PageHeader
        title="GitHub"
        description="Connect this server to GitHub, so that runs can push branches and open pull requests."
      />
      <ErrorText error={refresh.error} />
      <Panel
        title="Setup"
        action={
          currentStep === 0 ? (
            <Badge variant="success">Connected</Badge>
          ) : (
            <span className="text-muted-foreground">Step {currentStep} of 3</span>
          )
        }
      >
        <ol className="divide-y">
          <SetupStep
            number={1}
            title="Create the GitHub App"
            description="Halinka makes a GitHub App for this server. GitHub asks you to confirm it."
            state={createState}
          >
            {app ? <AppSummary app={app} /> : <CreateAppForm />}
          </SetupStep>
          <SetupStep
            number={2}
            title="Install the App"
            description="Select the account and the repos that the App can use. GitHub sends you back here."
            state={installState}
          >
            {app && (
              <>
                <Installations installations={installations} />
                <InstallActions
                  app={app}
                  isInstalled={isInstalled}
                  isRefreshing={refresh.isPending}
                  onRefresh={() => refresh.mutate()}
                />
              </>
            )}
          </SetupStep>
          <SetupStep
            number={3}
            title="Link the repos"
            description={
              <>
                Link a repo to let the App push it and open its pull requests. Without a link,
                Halinka uses the <span className="font-mono">gh</span> login of the runner.
              </>
            }
            state={linkState}
          >
            <RepoLinks githubRepos={githubRepos} />
          </SetupStep>
        </ol>
      </Panel>
      {app && (
        <DangerZone>
          <DisconnectApp app={app} />
        </DangerZone>
      )}
    </Page>
  );
};
