import { Alert, AlertDescription, AlertTitle } from "@halinka/ui/components/alert";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpCircleIcon } from "lucide-react";

import { api } from "../api";
import { useIsAdmin } from "../login/useIsAdmin";

type CommandProps = { children: string };

const Command = (props: CommandProps) => {
  const { children } = props;

  return <code className="font-mono text-foreground">{children}</code>;
};

export const UpdateBanner = () => {
  const isAdmin = useIsAdmin();
  const { data, isError } = useQuery({ ...api.serverUpdate.get.queryOptions(), enabled: isAdmin });
  if (!data?.update || isError) return null;
  const { update, currentVersion } = data;

  return (
    <div className="shrink-0 px-4 pt-4 md:px-8">
      <Alert className="mx-auto max-w-6xl">
        <ArrowUpCircleIcon />
        <AlertTitle>Halinka {update.latestVersion} is available</AlertTitle>
        <AlertDescription>
          <p>This server runs Halinka {currentVersion}.</p>
          {update.command === "start" ? (
            <p>
              Stop the server. Then start it with <Command>npx halinka@latest start</Command>.
            </p>
          ) : (
            <p>
              Back up the database. Then run <Command>docker compose pull</Command> and{" "}
              <Command>docker compose up -d</Command>.
            </p>
          )}
          {update.isProtocolChange && (
            <p>After the update, each runner stops its runs and installs the new version.</p>
          )}
        </AlertDescription>
      </Alert>
    </div>
  );
};
