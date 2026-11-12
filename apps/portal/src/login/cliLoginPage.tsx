import { Button } from "@halinka/ui/components/button";
import { useMutation } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";

import { api } from "../api";
import { ErrorText } from "../errorText";
import { Page, PageHeader } from "../page";

export const CliLoginPage = () => {
  const { code } = useSearch({ from: "/cli-login" });
  const approve = useMutation(api.cliLogin.approve.mutationOptions());

  return (
    <Page>
      <PageHeader title="Terminal login" />
      {!code ? (
        <p className="text-destructive">This link has no code. Run halinka login again.</p>
      ) : approve.isSuccess ? (
        <p>The terminal is logged in. You can close this page.</p>
      ) : (
        <div className="flex flex-col items-start gap-4">
          <p>
            A terminal asks to act as you on this server. Approve it only when your own terminal
            shows the code <span className="font-mono">{code}</span>.
          </p>
          <ErrorText error={approve.error} />
          <Button disabled={approve.isPending} onClick={() => approve.mutate({ userCode: code })}>
            Approve
          </Button>
        </div>
      )}
    </Page>
  );
};
