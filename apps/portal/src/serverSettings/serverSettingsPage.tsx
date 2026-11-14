import { Switch } from "@halinka/ui/components/switch";
import { useMutation, useQuery } from "@tanstack/react-query";

import { api } from "../api";
import { ErrorText } from "../errorText";
import { Page, PageHeader } from "../page";
import { Panel } from "../panel";
import { PanelRow } from "../panelRow";
import { QueryFallback } from "../queryFallback";
import { useInvalidateQueries } from "../useInvalidateQueries";

type UpdateCheckSwitchProps = { isOn: boolean };

const UpdateCheckSwitch = (props: UpdateCheckSwitchProps) => {
  const { isOn } = props;
  const refresh = useInvalidateQueries(api.serverSettings.get.key());
  const update = useMutation(api.serverSettings.update.mutationOptions({ onSuccess: refresh }));

  return (
    <div className="flex items-center gap-2">
      <ErrorText error={update.error} />
      <Switch
        checked={isOn}
        disabled={update.isPending}
        aria-label="Check for updates"
        onCheckedChange={(isUpdateCheckOn) => update.mutate({ isUpdateCheckOn })}
      />
      <span className="text-muted-foreground">{isOn ? "On" : "Off"}</span>
    </div>
  );
};

export const ServerSettingsPage = () => {
  const settings = useQuery(api.serverSettings.get.queryOptions());

  return (
    <Page>
      <PageHeader title="Server" description="The settings of this server." />
      {settings.data ? (
        <Panel title="Updates">
          <PanelRow
            title="Check for updates"
            description="The server reads the latest version of Halinka from the npm registry. It tells Admins when a new version is available."
          >
            <UpdateCheckSwitch isOn={settings.data.isUpdateCheckOn} />
          </PanelRow>
        </Panel>
      ) : (
        <QueryFallback error={settings.error} />
      )}
    </Page>
  );
};
