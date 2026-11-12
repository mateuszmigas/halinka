import { isDefinedError } from "@halinka/server/client";
import { Button } from "@halinka/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@halinka/ui/components/dialog";
import { Input } from "@halinka/ui/components/input";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheckIcon } from "lucide-react";
import { useState } from "react";

import { api } from "../api";
import { toFormErrors } from "../formErrors";
import { FieldFrame, FormActions, SelectField } from "../formFields";
import { FormShell } from "../formShell";
import { QueryFallback } from "../queryFallback";
import { useSubmitMutation } from "../useSubmitMutation";
import { settingsOf, settingsValuesOf } from "./runnerSettings";
import { AllowedAgentsField, LabelsField } from "./runnerSettingsFields";

// Other values of the target field are runner ids.
const newRunner = "new";

type ApproveFormProps = { userCode: string; hostName: string; onApproved: () => void };

const ApproveForm = (props: ApproveFormProps) => {
  const { userCode, hostName, onApproved } = props;
  const runners = useQuery(api.runners.list.queryOptions());
  const approve = useSubmitMutation(api.runners.approveRequest.mutationOptions());
  const form = useForm({
    defaultValues: { target: newRunner, name: hostName, ...settingsValuesOf() },
    validators: {
      onSubmitAsync: async ({ value }) => {
        const input =
          value.target === newRunner
            ? { userCode, name: value.name, ...settingsOf(value) }
            : { userCode, runnerId: Number(value.target) };
        const { error } = await approve(input);
        return error ? toFormErrors(error, ["name", "labels", "allowedAgents"]) : undefined;
      },
    },
    onSubmit: onApproved,
  });
  const replaceable = runners.data?.filter(({ state }) => state !== "revoked") ?? [];

  return (
    <FormShell form={form}>
      <form.Field name="target">
        {(field) => (
          <SelectField
            id={field.name}
            label="Approve as"
            placeholder="A new runner"
            value={field.state.value}
            onChange={field.handleChange}
            options={[
              { value: newRunner, label: "A new runner" },
              ...replaceable.map(({ id, name }) => ({
                value: String(id),
                label: `A new key of ${name}`,
              })),
            ]}
            disabled={runners.data === undefined}
            issues={[runners.error ?? undefined, ...field.state.meta.errors]}
          />
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.values.target === newRunner}>
        {(isNew) =>
          isNew && (
            <>
              <form.Field name="name">
                {(field) => (
                  <FieldFrame id={field.name} label="Name" issues={field.state.meta.errors}>
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
              <form.Field name="labels">
                {(field) => (
                  <LabelsField
                    id={field.name}
                    value={field.state.value}
                    onChange={field.handleChange}
                    issues={field.state.meta.errors}
                  />
                )}
              </form.Field>
              <form.Field name="allowedAgents">
                {(field) => (
                  <AllowedAgentsField
                    id={field.name}
                    value={field.state.value}
                    onChange={field.handleChange}
                    issues={field.state.meta.errors}
                  />
                )}
              </form.Field>
            </>
          )
        }
      </form.Subscribe>
      <FormActions>
        <Button type="submit">Approve</Button>
      </FormActions>
    </FormShell>
  );
};

type RequestDetailsProps = { userCode: string; onApproved: () => void };

// Approve only the machine that shows this code in its terminal: anyone can register a host name.
const RequestDetails = (props: RequestDetailsProps) => {
  const { userCode, onApproved } = props;
  const request = useQuery(api.runners.findRequest.queryOptions({ input: { userCode } }));

  if (isDefinedError(request.error) && request.error.code === "NOT_FOUND") {
    return (
      <p className="text-destructive">
        No machine asks with this code. Check the code, or run halinka runner again.
      </p>
    );
  }
  if (request.data === undefined) return <QueryFallback error={request.error} />;
  const { hostName, os, arch } = request.data;

  return (
    <div className="flex flex-col gap-4">
      <p>
        The machine <span className="font-semibold">{hostName}</span> ({os} {arch}) asks to become a
        runner. Approve it only when its terminal shows the code{" "}
        <span className="font-mono">{request.data.userCode}</span>.
      </p>
      <ApproveForm
        userCode={request.data.userCode}
        hostName={hostName ?? ""}
        onApproved={onApproved}
      />
    </div>
  );
};

type ApprovePanelProps = {
  code: string;
  onFind: (code: string) => void;
  onApproved: () => void;
};

const ApprovePanel = (props: ApprovePanelProps) => {
  const { code, onFind, onApproved } = props;
  const [typed, setTyped] = useState(code);

  return (
    <>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onFind(typed.trim());
        }}
      >
        <FieldFrame id="user-code" label="Code" issues={[]}>
          {(control) => (
            <Input
              {...control}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder="BCDF-GHJK"
              className="w-48 font-mono uppercase"
            />
          )}
        </FieldFrame>
        <Button type="submit" variant="outline">
          Find
        </Button>
      </form>
      {code && typed.trim() === code && (
        <RequestDetails key={code} userCode={code} onApproved={onApproved} />
      )}
    </>
  );
};

export type ApproveRunnerDialogProps = {
  // undefined: closed; "": open with no code.
  code: string | undefined;
  onCodeChange: (code: string | undefined) => void;
};

export const ApproveRunnerDialog = (props: ApproveRunnerDialogProps) => {
  const { code, onCodeChange } = props;

  return (
    <Dialog
      open={code !== undefined}
      onOpenChange={(isOpen) => onCodeChange(isOpen ? "" : undefined)}
    >
      <DialogTrigger render={<Button variant="outline" />}>
        <ShieldCheckIcon />
        Approve a runner
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Approve a runner</DialogTitle>
          <DialogDescription>
            Enter the code that the terminal of the runner shows.
          </DialogDescription>
        </DialogHeader>
        <ApprovePanel
          key={code}
          code={code ?? ""}
          onFind={onCodeChange}
          onApproved={() => onCodeChange(undefined)}
        />
      </DialogContent>
    </Dialog>
  );
};
