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
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";

import { api } from "../api";
import { toFormErrors } from "../formErrors";
import { FieldFrame, FormActions, SelectField } from "../formFields";
import { FormPopover } from "../formPopover";
import { FormShell } from "../formShell";
import { GitHubAvatar } from "../gitHubAvatar";
import { Page, PageHeader } from "../page";
import { Panel } from "../panel";
import { QueryFallback } from "../queryFallback";
import { RowMenu } from "../rowMenu";
import { useInvalidateQueries } from "../useInvalidateQueries";
import { useSubmitMutation } from "../useSubmitMutation";

type Member = ApiOutputs["members"]["list"][number];

type Role = Member["role"];

const roleLabels: Record<Role, string> = { admin: "Admin", member: "Member" };

type AddMemberFormProps = { onAdded: () => void };

const AddMemberForm = (props: AddMemberFormProps) => {
  const { onAdded } = props;
  const createMember = useSubmitMutation(api.members.create.mutationOptions());
  const refreshMembers = useInvalidateQueries(api.members.list.key());
  const form = useForm({
    defaultValues: { login: "", role: "member" as Role },
    validators: {
      onSubmitAsync: async ({ value }) => {
        const { error } = await createMember(value);
        return error ? toFormErrors(error, ["login", "role"]) : undefined;
      },
    },
    onSubmit: async () => {
      await refreshMembers();
      onAdded();
    },
  });

  return (
    <FormShell form={form}>
      <form.Field name="login">
        {(field) => (
          <FieldFrame id={field.name} label="GitHub user" issues={field.state.meta.errors}>
            {(control) => (
              <Input
                {...control}
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            )}
          </FieldFrame>
        )}
      </form.Field>
      <form.Field name="role">
        {(field) => (
          <SelectField
            id={field.name}
            label="Role"
            placeholder="Member"
            value={field.state.value}
            onChange={(value) => field.handleChange(value as Role)}
            options={Object.entries(roleLabels).map(([value, label]) => ({ value, label }))}
            disabled={false}
            issues={field.state.meta.errors}
          />
        )}
      </form.Field>
      <FormActions>
        <Button type="submit">Add</Button>
      </FormActions>
    </FormShell>
  );
};

type MemberMenuProps = { member: Member };

const MemberMenu = (props: MemberMenuProps) => {
  const { member } = props;
  const refreshMembers = useInvalidateQueries(api.members.list.key());
  const deleteMember = useMutation(
    api.members.delete.mutationOptions({ onSuccess: refreshMembers }),
  );

  return (
    <RowMenu
      name={member.login}
      items={[
        {
          label: "Delete",
          confirm: {
            title: `Delete ${member.login}?`,
            description:
              "This person is logged out at once and cannot log in again. Their past runs stay. Their stored keys go, so their runs use the keys of the team.",
            keepLabel: "Keep",
          },
          onSelect: () => deleteMember.mutate({ id: member.id }),
        },
      ]}
      isPending={deleteMember.isPending}
      error={deleteMember.error}
    />
  );
};

const AddMemberPopover = () => (
  <FormPopover label="Add member" icon={<PlusIcon />} title="Add a member">
    {(close) => <AddMemberForm onAdded={close} />}
  </FormPopover>
);

export const MembersPage = () => {
  const members = useQuery(api.members.list.queryOptions());

  return (
    <Page>
      <PageHeader
        title="Members"
        description="The people with access to this server."
        actions={<AddMemberPopover />}
      />
      {members.data ? (
        <Panel title="Members" hasHeader={false}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>GitHub user</TableHead>
                <TableHead>Role</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.data.map((member) => (
                <TableRow key={member.id}>
                  <TableCell data-cell="title">
                    <span className="flex items-center gap-2">
                      <GitHubAvatar login={member.login} />
                      {member.login}
                    </span>
                  </TableCell>
                  <TableCell data-cell="meta">{roleLabels[member.role]}</TableCell>
                  <TableCell data-cell="menu">
                    <MemberMenu member={member} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      ) : (
        <QueryFallback error={members.error} />
      )}
    </Page>
  );
};
