import type { ApiOutputs } from "@halinka/server/client";
import { Badge } from "@halinka/ui/components/badge";
import { Button } from "@halinka/ui/components/button";
import { Input } from "@halinka/ui/components/input";
import { Switch } from "@halinka/ui/components/switch";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { PlayIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, useState } from "react";

import { api } from "../api";
import { ErrorText } from "../errorText";
import { toFormErrors } from "../formErrors";
import { FieldFrame, FormActions, SelectField } from "../formFields";
import { FormPopover } from "../formPopover";
import { FormShell } from "../formShell";
import { useIsAdmin } from "../login/useIsAdmin";
import { Page, PageHeader } from "../page";
import { Panel } from "../panel";
import { QueryFallback } from "../queryFallback";
import { RowMenu } from "../rowMenu";
import { useInvalidateQueries } from "../useInvalidateQueries";
import { useSubmitMutation } from "../useSubmitMutation";
import { agentTestRowsOf } from "./agentTestRow";

type Agent = ApiOutputs["agents"]["list"][number];

type Credential = Agent["credentials"][number];

type AgentTest = Agent["tests"][number];

type Scope = "team" | "mine";

type BadgeSpec = { label: string; variant: ComponentProps<typeof Badge>["variant"] };

const stateBadges: Record<Credential["state"], BadgeSpec> = {
  set: { label: "Set", variant: "success" },
  not_set: { label: "Not set", variant: "secondary" },
  unreadable: { label: "Unreadable", variant: "warning" },
};

const testBadges: Record<AgentTest["status"], BadgeSpec> = {
  requested: { label: "Waiting for the runner", variant: "secondary" },
  running: { label: "Running", variant: "default" },
  passed: { label: "Passed", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
};

const testPollMs = 2000;

type SettingRowProps = {
  label: string;
  ariaLabel?: string;
  hasActionColumn?: boolean;
  children: ReactNode;
  action?: ReactNode;
};

const SettingRow = (props: SettingRowProps) => {
  const { label, ariaLabel, hasActionColumn = true, children, action } = props;

  return (
    <section
      aria-label={ariaLabel}
      className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-x-3 gap-y-1 px-4 py-2.5 sm:grid-cols-[7rem_minmax(0,1fr)_7rem]"
    >
      <span className="col-span-2 self-start text-muted-foreground sm:col-span-1 sm:pt-1.5">
        {label}
      </span>
      <div className={`flex min-w-0 flex-col gap-1 ${hasActionColumn ? "" : "col-span-2"}`}>
        {children}
      </div>
      {hasActionColumn && <div className="flex justify-end">{action}</div>}
    </section>
  );
};

type ValueFormProps = {
  id: string;
  apiField: string;
  label: string;
  isSecret?: boolean;
  placeholder?: string;
  initial?: string;
  submitLabel: string;
  save: (value: string) => Promise<unknown>;
  onSaved: () => void;
};

const ValueForm = (props: ValueFormProps) => {
  const { id, apiField, label, isSecret, placeholder, initial = "", submitLabel } = props;
  const { save, onSaved } = props;
  const refresh = useInvalidateQueries(api.agents.list.key());
  const saveValue = useSubmitMutation({ mutationFn: save });
  const form = useForm({
    defaultValues: { value: initial },
    validators: {
      onSubmitAsync: async ({ value }) => {
        const { error } = await saveValue(value.value);
        if (!error) return undefined;
        const { form, fields } = toFormErrors(error, [apiField]);
        return { form, fields: { value: fields[apiField] } };
      },
    },
    onSubmit: async () => {
      await refresh();
      onSaved();
    },
  });

  return (
    <FormShell form={form}>
      <form.Field name="value">
        {(field) => (
          <FieldFrame id={id} label={label} issues={field.state.meta.errors}>
            {(control) => (
              <Input
                {...control}
                type={isSecret ? "password" : "text"}
                autoComplete="off"
                placeholder={placeholder}
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            )}
          </FieldFrame>
        )}
      </form.Field>
      <FormActions>
        <Button type="submit">{submitLabel}</Button>
      </FormActions>
    </FormShell>
  );
};

type CredentialMenuProps = { preset: string; variable: string; scope: Scope };

const CredentialMenu = (props: CredentialMenuProps) => {
  const { preset, variable, scope } = props;
  const refresh = useInvalidateQueries(api.agents.list.key());
  const deleteCredential = useMutation({
    mutationFn: (input: { preset: string; variable: string }) =>
      scope === "mine"
        ? api.agents.deleteMyCredential.call(input)
        : api.agents.deleteCredential.call(input),
    onSuccess: refresh,
  });

  return (
    <RowMenu
      name={variable}
      items={[
        {
          label: "Delete",
          confirm: {
            title: `Delete ${variable}?`,
            description:
              scope === "mine"
                ? "The next agent start of your runs uses the keys of the team when you have no other key. A step that runs keeps the value."
                : "The next agent start uses the login or the environment of the runner. A step that runs keeps the value.",
            keepLabel: "Keep",
          },
          onSelect: () => deleteCredential.mutate({ preset, variable }),
        },
      ]}
      isPending={deleteCredential.isPending}
      error={deleteCredential.error}
    />
  );
};

type EnableSwitchProps = { agent: Agent };

const EnableSwitch = (props: EnableSwitchProps) => {
  const { agent } = props;
  const refresh = useInvalidateQueries(api.agents.list.key());
  const update = useMutation(api.agents.update.mutationOptions({ onSuccess: refresh }));

  return (
    <div className="flex items-center gap-2">
      <ErrorText error={update.error} />
      <Switch
        checked={agent.isEnabled}
        disabled={update.isPending}
        aria-label={`Enable ${agent.label}`}
        onCheckedChange={(isEnabled) => update.mutate({ preset: agent.preset, isEnabled })}
      />
      <span className="text-muted-foreground">{agent.isEnabled ? "Enabled" : "Disabled"}</span>
    </div>
  );
};

type KeysTableProps = {
  preset: string;
  credentials: Credential[];
  scope: Scope;
  canEdit: boolean;
};

const KeysTable = (props: KeysTableProps) => {
  const { preset, credentials, scope, canEdit } = props;
  const isMine = scope === "mine";

  return (
    <table className="w-full table-fixed">
      <colgroup>
        <col />
        <col className="w-[5.5rem]" />
        {canEdit && <col className="w-[7.75rem]" />}
      </colgroup>
      <tbody>
        {credentials.map(({ variable, state }) => (
          <tr key={variable}>
            <td className="py-1 pr-2">
              <p className="truncate font-mono" title={variable}>
                {variable}
              </p>
              {state === "unreadable" && (
                <p className="mt-1 text-muted-foreground">
                  Set with another master key. Enter it again.
                </p>
              )}
            </td>
            <td className="py-1 pr-2">
              <Badge variant={stateBadges[state].variant}>{stateBadges[state].label}</Badge>
            </td>
            {canEdit && (
              <td className="py-1">
                <div className="flex justify-end gap-1.5">
                  <FormPopover
                    variant="outline"
                    size="sm"
                    label={state === "not_set" ? "Set" : "Replace"}
                    ariaLabel={`${isMine ? "Set your" : "Set"} ${variable}`}
                    title={`${isMine ? "Your " : ""}${variable}`}
                    description={
                      isMine
                        ? "Your runs in a devcontainer use it in place of the key of the team. The runner of your run can read it, and a person who sends a message to your run spends it."
                        : "Runs in a devcontainer use it. Nobody can read it after you save it."
                    }
                  >
                    {(close) => (
                      <ValueForm
                        id={`${preset}-${scope}-${variable}`}
                        apiField="value"
                        label={isMine ? `Your new ${variable}` : `New ${variable}`}
                        isSecret
                        submitLabel="Save"
                        save={(value) => {
                          const input = { preset, variable, value };
                          return isMine
                            ? api.agents.setMyCredential.call(input)
                            : api.agents.setCredential.call(input);
                        }}
                        onSaved={close}
                      />
                    )}
                  </FormPopover>
                  {state !== "not_set" && (
                    <CredentialMenu preset={preset} variable={variable} scope={scope} />
                  )}
                </div>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

type TestFormProps = { agent: Agent; scope: Scope; onStarted: () => void };

const TestForm = (props: TestFormProps) => {
  const { agent, scope, onStarted } = props;
  const [runner, setRunner] = useState("");
  const refresh = useInvalidateQueries(api.agents.list.key());
  const runners = useQuery(api.runners.list.queryOptions());
  const test = useMutation({
    mutationFn: (input: { preset: string; runner: string }) =>
      scope === "mine" ? api.agents.testMine.call(input) : api.agents.test.call(input),
    onSuccess: async () => {
      await refresh();
      onStarted();
    },
  });
  const options = runners.data
    ?.filter(({ isConnected, allowedAgents, sandboxKind }) => {
      if (scope === "mine" && sandboxKind !== "devcontainer") return false;
      return isConnected && (!allowedAgents || allowedAgents.includes(agent.preset));
    })
    .map(({ name }) => ({ value: name, label: name }));

  return (
    <>
      <SelectField
        id={`${agent.preset}-${scope}-test-runner`}
        label={scope === "mine" ? "Test your key on runner" : "Test on runner"}
        issues={test.error ? [{ message: test.error.message }] : []}
        placeholder="Select a runner"
        value={runner}
        onChange={setRunner}
        options={options}
        disabled={!options?.length}
      />
      <FormActions>
        <Button
          disabled={!runner || test.isPending}
          onClick={() => test.mutate({ preset: agent.preset, runner })}
        >
          Test
        </Button>
      </FormActions>
    </>
  );
};

type TestsTableProps = { tests: AgentTest[] };

const TestsTable = (props: TestsTableProps) => {
  const { tests } = props;

  if (tests.length === 0) return <span className="text-muted-foreground">Not tested</span>;

  return (
    <table className="w-full">
      <tbody>
        {tests.map(({ runner, status, capabilities, error, isOutdated }) => {
          const details = error ?? Object.keys(capabilities ?? {}).join(", ");
          return (
            <tr key={runner}>
              <td className="w-0 py-0.5 pr-2">
                <Badge variant={testBadges[status].variant}>{testBadges[status].label}</Badge>
              </td>
              <td className="w-0 py-0.5 pr-2 whitespace-nowrap">{runner}</td>
              <td className="max-w-0 truncate py-0.5 text-muted-foreground" title={details}>
                {isOutdated && "Old: the version or a key changed after the test. "}
                {details}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

type TestRowProps = {
  agent: Agent;
  scope: Scope;
  label: string;
  tests: AgentTest[];
  canTest: boolean;
};

const TestRow = (props: TestRowProps) => {
  const { agent, scope, label, tests, canTest } = props;

  return (
    <SettingRow
      label={label}
      action={
        canTest && (
          <FormPopover
            variant="outline"
            size="sm"
            label="Run a test"
            icon={<PlayIcon />}
            title={`Test ${agent.label}`}
            description="The test asks the agent for a one-word reply, which costs a small amount."
          >
            {(close) => <TestForm agent={agent} scope={scope} onStarted={close} />}
          </FormPopover>
        )
      }
    >
      <TestsTable tests={tests} />
    </SettingRow>
  );
};

type AgentFieldRowProps = {
  agent: Agent;
  field: "version" | "model";
  label: string;
  description: string;
  canEdit: boolean;
  children: ReactNode;
};

const AgentFieldRow = (props: AgentFieldRowProps) => {
  const { agent, field, label, description, canEdit, children } = props;
  const { preset } = agent;

  return (
    <SettingRow
      label={label}
      action={
        canEdit && (
          <FormPopover
            variant="outline"
            size="sm"
            label="Change"
            ariaLabel={`Change the ${label.toLowerCase()} of ${agent.label}`}
            title={`${label} of ${agent.label}`}
            description={description}
          >
            {(close) => (
              <ValueForm
                id={`${preset}-${field}`}
                apiField={field}
                label={label}
                placeholder={field === "version" ? agent.defaultVersion : undefined}
                initial={agent[field] ?? ""}
                submitLabel={`Save ${field}`}
                save={(value) => {
                  const setting = value.trim() || null;
                  return api.agents.update.call(
                    field === "version" ? { preset, version: setting } : { preset, model: setting },
                  );
                }}
                onSaved={close}
              />
            )}
          </FormPopover>
        )
      }
    >
      {children}
    </SettingRow>
  );
};

type AgentCardProps = { agent: Agent };

const AgentCard = (props: AgentCardProps) => {
  const { agent } = props;
  const isAdmin = useIsAdmin();
  const { preset, mine } = agent;
  const version = agent.version ?? agent.defaultVersion;
  const testRows = agentTestRowsOf(agent, isAdmin);

  return (
    <Panel
      title={agent.label}
      action={
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground">
            version {version}
            {agent.model && `, model ${agent.model}`}
          </span>
          {isAdmin ? (
            <EnableSwitch agent={agent} />
          ) : (
            <Badge variant={agent.isEnabled ? "success" : "secondary"}>
              {agent.isEnabled ? "Enabled" : "Disabled"}
            </Badge>
          )}
        </div>
      }
    >
      <div className="divide-y">
        <SettingRow label="Team keys" hasActionColumn={false}>
          <KeysTable
            preset={preset}
            credentials={agent.credentials}
            scope="team"
            canEdit={isAdmin}
          />
        </SettingRow>
        {mine && (
          <SettingRow
            label="Your keys"
            ariaLabel={`Your keys of ${agent.label}`}
            hasActionColumn={false}
          >
            <KeysTable preset={preset} credentials={mine.credentials} scope="mine" canEdit />
          </SettingRow>
        )}
        <AgentFieldRow
          agent={agent}
          field="version"
          label="Version"
          description="A container installs this version when it has no command of the agent. A worktree run uses the command on the runner."
          canEdit={isAdmin}
        >
          <span className="font-mono">{version}</span>
        </AgentFieldRow>
        <AgentFieldRow
          agent={agent}
          field="model"
          label="Default model"
          description="For a step without a model. Leave it empty to use the default of the agent. A model that the agent does not offer stops the step."
          canEdit={isAdmin}
        >
          <span className={agent.model ? undefined : "text-muted-foreground"}>
            {agent.model ?? "Default of the agent"}
          </span>
        </AgentFieldRow>
        {testRows.map(({ scope, label, tests, canTest }) => (
          <TestRow
            key={scope}
            agent={agent}
            scope={scope}
            label={label}
            tests={tests}
            canTest={canTest}
          />
        ))}
      </div>
    </Panel>
  );
};

export const AgentsPage = () => {
  const agents = useQuery({
    ...api.agents.list.queryOptions(),
    refetchInterval: ({ state }) =>
      state.data?.some(({ tests, mine }) =>
        [...tests, ...(mine?.tests ?? [])].some(
          ({ status }) => status === "requested" || status === "running",
        ),
      )
        ? testPollMs
        : false,
  });

  return (
    <Page>
      <PageHeader
        title="Agents"
        description="The agents that steps use. Stored keys reach only runs in a devcontainer, through the egress proxy; a worktree run uses the login of its runner."
      />
      {agents.data ? (
        <div className="grid items-start gap-6 xl:grid-cols-2">
          {agents.data.map((agent) => (
            <AgentCard key={agent.preset} agent={agent} />
          ))}
        </div>
      ) : (
        <QueryFallback error={agents.error} />
      )}
    </Page>
  );
};
