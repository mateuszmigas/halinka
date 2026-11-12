import { Button } from "@halinka/ui/components/button";
import { useForm, useStore } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { api } from "../api";
import { toFormErrors } from "../formErrors";
import { FieldAction, SelectField } from "../formFields";
import { FormShell } from "../formShell";
import { useInvalidateQueries } from "../useInvalidateQueries";
import { useSubmitMutation } from "../useSubmitMutation";

export type AddGitHubRepoFormProps = { onAdded: () => void };

export const AddGitHubRepoForm = (props: AddGitHubRepoFormProps) => {
  const { onAdded } = props;
  const createRepo = useSubmitMutation(api.repos.createGitHub.mutationOptions());
  const refreshRepos = useInvalidateQueries(api.repos.list.key());
  const status = useQuery(api.github.status.queryOptions());
  const repos = useQuery(api.repos.list.queryOptions());
  const form = useForm({
    defaultValues: { githubRepoId: "" },
    validators: {
      onSubmitAsync: async ({ value }) => {
        const input = { githubRepoId: Number(value.githubRepoId) };
        const { error } = await createRepo(input);
        return error ? toFormErrors(error, ["githubRepoId"]) : undefined;
      },
    },
    onSubmit: () => {
      form.reset();
      void refreshRepos();
      onAdded();
    },
  });
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting);
  const githubRepoId = useStore(form.store, (state) => state.values.githubRepoId);

  if (!repos.data || !status.data) return null;
  if (!status.data.app) {
    return (
      <p className="text-muted-foreground">
        Connect the GitHub App on the{" "}
        <Link to="/github" className="text-link hover:underline">
          GitHub page
        </Link>{" "}
        first.
      </p>
    );
  }
  const added = repos.data.filter(({ kind }) => kind === "github");
  const addable = status.data.installations
    .flatMap((installation) => installation.repos)
    .filter(({ githubId }) => !added.some((repo) => repo.githubRepoId === githubId));
  if (addable.length === 0) {
    return (
      <p className="text-muted-foreground">
        The App has no more repos to add. To add more repos, open the{" "}
        <Link to="/github" className="text-link hover:underline">
          GitHub page
        </Link>{" "}
        and select them on GitHub.
      </p>
    );
  }
  return (
    <FormShell form={form}>
      <div className="flex flex-wrap items-start gap-4">
        <form.Field name="githubRepoId">
          {(field) => (
            <SelectField
              id={field.name}
              label="GitHub repo"
              placeholder="Select a GitHub repo"
              value={field.state.value}
              onChange={field.handleChange}
              options={addable.map(({ githubId, owner, name }) => ({
                value: String(githubId),
                label: `${owner}/${name}`,
              }))}
              disabled={isSubmitting}
              issues={field.state.meta.errors}
            />
          )}
        </form.Field>
        <FieldAction>
          <Button type="submit" disabled={isSubmitting || githubRepoId === ""}>
            Add GitHub repo
          </Button>
        </FieldAction>
      </div>
    </FormShell>
  );
};
