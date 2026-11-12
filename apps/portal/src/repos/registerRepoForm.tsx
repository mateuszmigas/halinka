import { isDefinedError } from "@halinka/server/client";
import { Button } from "@halinka/ui/components/button";
import { Input } from "@halinka/ui/components/input";
import { useForm, useStore } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../api";
import { toFormErrors } from "../formErrors";
import { FieldAction, FieldFrame, SelectField } from "../formFields";
import { FormShell } from "../formShell";
import { useInvalidateQueries } from "../useInvalidateQueries";
import { useSubmitMutation } from "../useSubmitMutation";
import { FolderBrowser } from "./folderBrowser";
import { InitRepoPanel } from "./initRepoPanel";

export type RegisterRepoFormProps = { onRegistered: () => void };

export const RegisterRepoForm = (props: RegisterRepoFormProps) => {
  const { onRegistered } = props;
  const register = useSubmitMutation(api.repos.register.mutationOptions());
  const refreshRepos = useInvalidateQueries(api.repos.list.key());
  const [browsing, setBrowsing] = useState<{ start?: string }>();
  const [notSetUp, setNotSetUp] = useState<{
    runnerId: number;
    path: string;
    devcontainers: string[];
  }>();
  const runners = useQuery(api.runners.list.queryOptions());
  const registered = () => {
    form.reset();
    setBrowsing(undefined);
    setNotSetUp(undefined);
    void refreshRepos();
    onRegistered();
  };
  const form = useForm({
    // Field values are strings; "" is no value.
    defaultValues: { runnerId: "", path: "" },
    validators: {
      // The server check is the submit validator, so its errors clear when the user types.
      onSubmitAsync: async ({ value }) => {
        const input = { runnerId: Number(value.runnerId), path: value.path };
        const { error } = await register(input);
        setNotSetUp(
          isDefinedError(error) && error.code === "REPO_NOT_SET_UP"
            ? { ...input, devcontainers: error.data.devcontainers }
            : undefined,
        );
        return error ? toFormErrors(error, ["runnerId", "path"]) : undefined;
      },
    },
    onSubmit: registered,
  });
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting);
  const runnerId = useStore(form.store, (state) => state.values.runnerId);
  const path = useStore(form.store, (state) => state.values.path);
  // The panel writes to the runner and the path that Register refused, so it closes when they change.
  const initTarget =
    notSetUp?.runnerId === Number(runnerId) && notSetUp.path === path ? notSetUp : undefined;

  const toggleBrowse = () => {
    if (browsing) return setBrowsing(undefined);
    const path = form.getFieldValue("path");
    setBrowsing({ start: path.startsWith("/") ? path : undefined });
  };

  return (
    <FormShell form={form}>
      <div className="flex flex-wrap items-start gap-4">
        <form.Field name="runnerId">
          {(field) => (
            <SelectField
              id={field.name}
              label="Runner"
              placeholder="Select a runner"
              value={field.state.value}
              onChange={field.handleChange}
              options={runners.data?.map((runner) => ({
                value: String(runner.id),
                label: runner.isConnected ? runner.name : `${runner.name} (offline)`,
              }))}
              disabled={isSubmitting || runners.data === undefined}
              issues={[runners.error ?? undefined, ...field.state.meta.errors]}
            />
          )}
        </form.Field>
        <form.Field name="path">
          {(field) => (
            <FieldFrame
              id={field.name}
              label="Repo path"
              issues={field.state.meta.errors}
              className="min-w-0 max-w-xl flex-1"
            >
              {(control) => (
                <Input
                  {...control}
                  name={field.name}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={field.handleBlur}
                  placeholder="/path/to/repo"
                  className="font-mono"
                />
              )}
            </FieldFrame>
          )}
        </form.Field>
        <FieldAction>
          <Button
            variant="outline"
            onClick={toggleBrowse}
            disabled={isSubmitting || runnerId === ""}
          >
            Browse
          </Button>
          <Button type="submit" disabled={isSubmitting || runnerId === ""}>
            Register
          </Button>
        </FieldAction>
      </div>
      {browsing && runnerId !== "" && (
        <FolderBrowser
          key={runnerId}
          runnerId={Number(runnerId)}
          start={browsing.start}
          onSelect={(selected) => {
            form.setFieldValue("path", selected);
            setBrowsing(undefined);
          }}
        />
      )}
      {initTarget && (
        <InitRepoPanel
          key={`${initTarget.runnerId} ${initTarget.path}`}
          {...initTarget}
          onDone={registered}
        />
      )}
    </FormShell>
  );
};
