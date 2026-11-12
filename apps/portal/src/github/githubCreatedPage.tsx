import { Button } from "@halinka/ui/components/button";
import { useMutation } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";

import { api } from "../api";
import { ErrorText } from "../errorText";
import { Page, PageHeader } from "../page";

export const GitHubCreatedPage = () => {
  const { code, state } = useSearch({ from: "/github/created" });
  const connect = useMutation(
    api.github.connect.mutationOptions({
      onSuccess: ({ installUrl }) => window.location.assign(installUrl),
    }),
  );

  return (
    <Page>
      <PageHeader title="Connect the GitHub App" />
      {!code || !state ? (
        <p className="text-destructive">This link has no code. Create the App again.</p>
      ) : (
        <div className="flex flex-col items-start gap-4">
          <p>
            GitHub created the App. Connect it only when you started this from the GitHub page of
            this server. Then install the App on GitHub.
          </p>
          <ErrorText error={connect.error} />
          <Button
            disabled={connect.isPending || connect.isSuccess}
            onClick={() => connect.mutate({ code, state })}
          >
            Connect the App
          </Button>
        </div>
      )}
    </Page>
  );
};
