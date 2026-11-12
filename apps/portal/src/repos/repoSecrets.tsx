import { Badge } from "@halinka/ui/components/badge";
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
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";

import { api } from "../api";
import { toFormErrors } from "../formErrors";
import { FieldFrame } from "../formFields";
import { FormPopover } from "../formPopover";
import { FormShell } from "../formShell";
import { useIsAdmin } from "../login/useIsAdmin";
import { Panel } from "../panel";
import { PanelBody } from "../panelBody";
import { PanelEmpty } from "../panelEmpty";
import { QueryFallback } from "../queryFallback";
import { RowMenu } from "../rowMenu";
import { useInvalidateQueries } from "../useInvalidateQueries";
import { useSubmitMutation } from "../useSubmitMutation";

type SetSecretFormProps = { repoId: number; onSaved: () => void };

const SetSecretForm = ({ repoId, onSaved }: SetSecretFormProps) => {
  const setSecret = useSubmitMutation(api.repos.setSecret.mutationOptions());
  const refresh = useInvalidateQueries(api.repos.secrets.key({ input: { id: repoId } }));
  const form = useForm({
    defaultValues: { name: "", value: "" },
    validators: {
      onSubmitAsync: async ({ value }) => {
        const { error } = await setSecret({ id: repoId, ...value });
        if (!error) return undefined;
        return toFormErrors(error, ["name", "value"]);
      },
    },
    onSubmit: async () => {
      await refresh();
      onSaved();
    },
  });

  return (
    <FormShell form={form}>
      <form.Field name="name">
        {(field) => (
          <FieldFrame id={field.name} label="Name" issues={field.state.meta.errors}>
            {(control) => (
              <Input
                {...control}
                autoComplete="off"
                placeholder="NPM_TOKEN"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            )}
          </FieldFrame>
        )}
      </form.Field>
      <form.Field name="value">
        {(field) => (
          <FieldFrame id={field.name} label="Value" issues={field.state.meta.errors}>
            {(control) => (
              <Input
                {...control}
                type="password"
                autoComplete="off"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            )}
          </FieldFrame>
        )}
      </form.Field>
      <Button type="submit" className="self-end">
        Save secret
      </Button>
    </FormShell>
  );
};

type SecretMenuProps = { repoId: number; name: string };

const SecretMenu = ({ repoId, name }: SecretMenuProps) => {
  const refresh = useInvalidateQueries(api.repos.secrets.key({ input: { id: repoId } }));
  const deleteSecret = useMutation(api.repos.deleteSecret.mutationOptions({ onSuccess: refresh }));

  return (
    <RowMenu
      name={name}
      items={[
        {
          label: "Delete",
          confirm: {
            title: `Delete ${name}?`,
            description:
              "A new run that names this secret is refused. A run that is set up already keeps running.",
            keepLabel: "Keep",
          },
          onSelect: () => deleteSecret.mutate({ id: repoId, name }),
        },
      ]}
      isPending={deleteSecret.isPending}
      error={deleteSecret.error}
    />
  );
};

type RepoSecretsProps = { repoId: number };

export const RepoSecrets = ({ repoId }: RepoSecretsProps) => {
  const isAdmin = useIsAdmin();
  const secrets = useQuery(api.repos.secrets.queryOptions({ input: { id: repoId } }));

  return (
    <Panel
      title="Secrets"
      count={secrets.data?.length}
      action={
        isAdmin && (
          <FormPopover
            label="Add secret"
            icon={<PlusIcon />}
            size="sm"
            variant="outline"
            title="Add secret"
          >
            {(close) => <SetSecretForm repoId={repoId} onSaved={close} />}
          </FormPopover>
        )
      }
    >
      <PanelBody>
        <p className="text-muted-foreground">
          Only the setup command of .halinka/config.yml gets the secrets that it names, and only in
          a devcontainer. The agents do not get them.
        </p>
      </PanelBody>
      {secrets.data === undefined ? (
        <PanelBody>
          <QueryFallback error={secrets.error} />
        </PanelBody>
      ) : secrets.data.length === 0 ? (
        <PanelEmpty>No secret.</PanelEmpty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Stored value</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {secrets.data.map(({ name, isReadable }) => (
              <TableRow key={name}>
                <TableCell data-cell="title" className="font-mono">
                  {name}
                </TableCell>
                <TableCell>
                  <Badge variant={isReadable ? "success" : "warning"}>
                    {isReadable ? "Set" : "Unreadable"}
                  </Badge>
                  {!isReadable && (
                    <p className="mt-1 text-muted-foreground">
                      Set with another master key. Enter it again.
                    </p>
                  )}
                </TableCell>
                <TableCell data-cell="menu">
                  {isAdmin && <SecretMenu repoId={repoId} name={name} />}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
};
